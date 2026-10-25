import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const authorization = `Basic ${Buffer.from("reader:test-secret").toString("base64")}`;
const narKey = `nar/${"0".repeat(52)}.nar.zst`;
const infoKey = `${"0".repeat(32)}.narinfo`;
let runtime: Miniflare;

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    ssr: { noExternal: true },
    build: {
      ssr: fileURLToPath(new URL("./workerd-entry.ts", import.meta.url)),
      write: false,
      minify: false,
    },
  });
  const built = Array.isArray(result) ? result[0] : result;
  if (!built || !("output" in built)) throw new Error("Expected a completed Worker build");
  const chunk = built.output.find((entry) => entry.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing acceptance Worker bundle");
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "nix-cache-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: chunk.code } },
          },
          env: {
            BUCKET: {
              type: "r2",
              name: "test-cache",
              dev: {
                experimentalS3Credentials: {
                  accessKeyId: "local-test-access-key",
                  secretAccessKey: "local-test-secret-key",
                },
              },
            },
          },
        },
      },
    ],
  });
  await runtime.ready;
}, 60000);

afterAll(async () => {
  await runtime?.dispose();
});

const request = (
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) =>
  runtime.dispatchFetch(`https://cache.example.com/${path}`, {
    ...init,
    headers: { authorization, ...init.headers },
  });

describe("private Nix binary cache on workerd", () => {
  it("authenticates even a warm cache and does not expose public cache headers", async () => {
    const bucket = await runtime.getR2Bucket("BUCKET");
    await bucket.put("nix-cache-info", "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n");
    const first = await request("nix-cache-info");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.text()).toContain("StoreDir: /nix/store");
    // dispatchFetch's waitUntil settles after consumption, allowing a real cache hit.
    await bucket.delete("nix-cache-info");
    const cached = await request("nix-cache-info");
    expect(cached.status).toBe(200);
    expect(await cached.text()).toContain("StoreDir: /nix/store");
    const unauthenticated = await runtime.dispatchFetch("https://cache.example.com/nix-cache-info");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain("Basic");
    const wrong = await request("nix-cache-info", { headers: { authorization: "Basic bad" } });
    expect(wrong.status).toBe(401);
  });

  it("streams binary NAR data and supports HEAD, ranges and validators", async () => {
    const bucket = await runtime.getR2Bucket("BUCKET");
    const bytes = Uint8Array.of(0, 255, 1, 128, 2, 3, 4, 5);
    await bucket.put(narKey, bytes);
    const head = await request(narKey, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("8");
    expect(await head.text()).toBe("");
    const range = await request(narKey, { headers: { range: "bytes=1-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/8");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(1, 4));
    const suffix = await request(narKey, { headers: { range: "bytes=-2" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-2));
    const full = await request(narKey);
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    const conditional = await request(narKey, {
      headers: { "if-none-match": head.headers.get("etag")! },
    });
    expect(conditional.status).toBe(304);
    expect((await request(narKey, { headers: { "if-match": '"stale"' } })).status).toBe(412);
    expect(
      (
        await request(narKey, {
          headers: { "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await request(narKey, {
          headers: { "if-modified-since": head.headers.get("last-modified")! },
        })
      ).status,
    ).toBe(304);
    const stale = await request(narKey, { headers: { range: "bytes=1-3", "if-range": '"stale"' } });
    expect(stale.status).toBe(200);
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(bytes);
    const invalid = await request(narKey, { headers: { range: "bytes=99-" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */8");
  });

  it("rechecks If-Range when R2 changes between HEAD and GET", async () => {
    const key = `nar/${"2".repeat(52)}.nar.zst`;
    const bucket = await runtime.getR2Bucket("BUCKET");
    const original = await bucket.put(key, "original-content");
    const response = await request(key, {
      headers: {
        range: "bytes=0-3",
        "if-range": original.httpEtag,
        "x-test-replace-after-head": "1",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe("replacement-content");
  });

  it("pushes via authenticated S3 and pulls the same NAR via authenticated Worker HTTP", async () => {
    const run = promisify(execFile);
    await mkdir("tmp", { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), "tmp", "nix-roundtrip-"));
    const execute = (command: string, args: string[], options?: { env: NodeJS.ProcessEnv }) =>
      run(command, args, {
        env: {
          ...process.env,
          ...options?.env,
          XDG_CACHE_HOME: join(directory, "nix-cache"),
          NIX_CONFIG: `${process.env.NIX_CONFIG ?? ""}\nnarinfo-cache-positive-ttl = 0\nnarinfo-cache-negative-ttl = 0\n`,
        },
      });
    try {
      const { stdout: storePath } = await execute("nix", [
        "eval",
        "--raw",
        "--expr",
        `builtins.toFile "nix-cache-probe" ${JSON.stringify(`authenticated roundtrip ${directory}\n`)}`,
      ]);
      const url = await runtime.ready;
      // Miniflare exposes S3 under this path prefix; Nix's store prefix keeps
      // the SigV4 canonical URL unchanged without introducing a mock proxy.
      const s3 = `s3://cdn-cgi/local/r2/s3/test-cache?scheme=http&endpoint=${url.host}&region=auto&compression=zstd`;
      await expect(
        execute("nix", ["copy", "--to", s3, storePath], {
          env: {
            ...process.env,
            AWS_ACCESS_KEY_ID: "local-test-access-key",
            AWS_SECRET_ACCESS_KEY: "invalid-secret",
            AWS_EC2_METADATA_DISABLED: "true",
          },
        }),
      ).rejects.toThrow();
      await execute("nix", ["copy", "--to", s3, storePath], {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: "local-test-access-key",
          AWS_SECRET_ACCESS_KEY: "local-test-secret-key",
          AWS_EC2_METADATA_DISABLED: "true",
        },
      });
      const netrc = join(directory, "netrc");
      await writeFile(netrc, `machine ${url.hostname}\nlogin reader\npassword test-secret\n`, {
        mode: 0o600,
      });
      const wrongNetrc = join(directory, "wrong-netrc");
      await writeFile(wrongNetrc, `machine ${url.hostname}\nlogin reader\npassword incorrect\n`, {
        mode: 0o600,
      });
      await expect(
        execute("nix", [
          "store",
          "dump-path",
          "--store",
          url.toString(),
          "--option",
          "netrc-file",
          wrongNetrc,
          storePath,
        ]),
      ).rejects.toThrow();
      const expected = await execute("nix", ["store", "dump-path", storePath]);
      const pulled = `file://${join(directory, "pulled")}`;
      await execute("nix", [
        "copy",
        "--from",
        url.toString(),
        "--to",
        pulled,
        "--option",
        "netrc-file",
        netrc,
        storePath,
      ]);
      const actual = await execute("nix", ["store", "dump-path", "--store", pulled, storePath]);
      expect(actual.stdout).toBe(expected.stdout);
      expect(actual.stdout).toContain("authenticated roundtrip");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  it("never caches missing narinfo and rejects write and cache-busting requests", async () => {
    const missing = await request(infoKey);
    expect(missing.status).toBe(404);
    const bucket = await runtime.getR2Bucket("BUCKET");
    await bucket.put(infoKey, "StorePath: /nix/store/example\n");
    const available = await request(infoKey);
    expect(available.status).toBe(200);
    expect(await available.text()).toContain("StorePath:");
    const write = await request(infoKey, { method: "PUT", body: "no" });
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");
    expect((await request(`${infoKey}?bust=1`)).status).toBe(404);
    expect((await request("other-secret-file")).status).toBe(404);
    expect((await request("%2e%2e/secret")).status).toBe(404);
  });
});
