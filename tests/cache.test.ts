import { Array, Config, Effect, FileSystem, Option, Path, Schema, String } from "effect";
import { Base64 } from "effect/encoding";
import type { ChildProcess } from "effect/process";
import type { Miniflare } from "miniflare";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { command, miniflare, runTest } from "./support";

const authorization = `Basic ${Base64.encode("reader:test-secret")}`;
const narKey = `nar/${String.repeat(52)("0")}.nar.zst`;
const infoKey = `${String.repeat(32)("0")}.narinfo`;
const bytes = new Uint8Array([0, 255, 1, 128, 2, 3, 4, 5]);
let bundle: string;

beforeAll(
  () =>
    runTest(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // Vite's compiler and Miniflare's Cloudflare interfaces are Promise-based test boundaries.
        const result = yield* Effect.promise(() =>
          build({
            configFile: false,
            logLevel: "error",
            ssr: { noExternal: true },
            build: { ssr: path.resolve("tests/workerd-entry.ts"), write: false, minify: false },
          }),
        );
        const built = Array.isArray(result) ? result[0] : result;
        if (!built || !("output" in built)) throw new Error("Expected a completed Worker build");
        const chunk = Option.getOrThrowWith(
          Array.findFirst(built.output, (entry) => entry.type === "chunk"),
          () => new Error("Missing acceptance Worker bundle"),
        );
        if (chunk.type !== "chunk") throw new Error("Expected an executable Worker chunk");
        bundle = chunk.code;
      }),
    ),
  60_000,
);

const cacheRuntime = () =>
  miniflare({
    workers: [
      {
        config: {
          name: "nix-cache-test",
          compatibilityDate: "2026-09-25",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle } },
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

type NativeResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
const request = (
  runtime: Miniflare,
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  Effect.promise(() =>
    runtime.dispatchFetch(`https://cache.example.com/${path}`, {
      ...init,
      headers: { authorization, ...init.headers },
    }),
  );
const text = (response: NativeResponse) => Effect.promise(() => response.text());
// Uint8Array conversion is confined to the native response body's binary boundary.
const bodyBytes = (response: NativeResponse) =>
  Effect.map(
    Effect.promise(() => response.arrayBuffer()),
    (buffer) => Array.fromIterable(new Uint8Array(buffer)),
  );
const seed = (runtime: Miniflare) =>
  Effect.gen(function* () {
    const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
    yield* Effect.promise(() => bucket.put(narKey, bytes));
    return bucket;
  });

it("a warm cache still authenticates and never exposes public caching headers", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      yield* Effect.promise(() => bucket.put("nix-cache-info", "StoreDir: /nix/store\n"));
      const first = yield* request(runtime, "nix-cache-info");
      expect(first.status).toBe(200);
      expect(yield* text(first)).toBe("StoreDir: /nix/store\n");
      // Removing the origin object proves the second response comes from the real Cache API.
      yield* Effect.promise(() => bucket.delete("nix-cache-info"));
      const cached = yield* request(runtime, "nix-cache-info");
      expect(cached.status).toBe(200);
      expect(cached.headers.get("cache-control")).toBe("private, no-store");
      expect(cached.headers.get("vary")).toBe("Authorization");
      expect(yield* text(cached)).toBe("StoreDir: /nix/store\n");
      const denied = yield* request(runtime, "nix-cache-info", { headers: { authorization: "" } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("Basic");
    }),
  ));

it.each(["", "Basic bad", `Basic ${Base64.encode("reader:incorrect")}`])(
  "rejects invalid reader credentials: %s",
  (invalid) =>
    runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime();
        const response = yield* request(runtime, narKey, { headers: { authorization: invalid } });
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }),
    ),
);

it("streams a complete binary NAR without converting its payload to text", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("8");
      expect(yield* bodyBytes(response)).toEqual(Array.fromIterable(bytes));
    }),
  ));

it("HEAD returns metadata without a body", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("8");
      expect(yield* text(response)).toBe("");
    }),
  ));

it("lets the Cache API decide whether to store an object above the former size cap", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      const aboveFormerCap = 128 * 1024 * 1024 + 1;
      // Native bytes belong to the R2 and response body interoperability boundary.
      yield* Effect.promise(() => bucket.put(narKey, new Uint8Array(aboveFormerCap)));
      const first = yield* request(runtime, narKey);
      expect(first.status).toBe(200);
      expect((yield* Effect.promise(() => first.arrayBuffer())).byteLength).toBe(aboveFormerCap);
      yield* Effect.promise(() => bucket.delete(narKey));
      const cached = yield* request(runtime, narKey);
      expect(cached.status).toBe(200);
      expect(cached.headers.get("cache-control")).toBe("private, no-store");
      expect((yield* Effect.promise(() => cached.arrayBuffer())).byteLength).toBe(aboveFormerCap);
    }),
  ));

it.each([
  { range: "bytes=1-3", expected: [255, 1, 128], contentRange: "bytes 1-3/8" },
  { range: "bytes=-2", expected: [4, 5], contentRange: "bytes 6-7/8" },
  { range: "bytes=6-", expected: [4, 5], contentRange: "bytes 6-7/8" },
  { range: "bytes=6-99", expected: [4, 5], contentRange: "bytes 6-7/8" },
  { range: "bytes=-99", expected: Array.fromIterable(bytes), contentRange: "bytes 0-7/8" },
])("serves the requested byte range $range", ({ range, expected, contentRange }) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey, { headers: { range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(yield* bodyBytes(response)).toEqual(expected);
    }),
  ),
);

it.each(["bytes=99-", "bytes=4-1", "bytes=-0", "bytes=1.5-3", "bytes=1e0-3", "bytes=0-1,4-5"])(
  "rejects unsupported or unsatisfiable range %s",
  (range) =>
    runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime();
        yield* seed(runtime);
        const response = yield* request(runtime, narKey, { headers: { range } });
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */8");
      }),
    ),
);

const validators: ReadonlyArray<{
  name: string;
  headers: (metadata: { etag: string; modified: string }) => Record<string, string>;
  status: number;
}> = [
  {
    name: "matching If-None-Match",
    headers: ({ etag }) => ({ "if-none-match": etag }),
    status: 304,
  },
  {
    name: "weak If-None-Match",
    headers: ({ etag }) => ({ "if-none-match": `W/${etag}` }),
    status: 304,
  },
  {
    name: "matching If-Modified-Since",
    headers: ({ modified }) => ({ "if-modified-since": modified }),
    status: 304,
  },
  { name: "stale If-Match", headers: () => ({ "if-match": '"stale"' }), status: 412 },
  { name: "weak If-Match", headers: ({ etag }) => ({ "if-match": `W/${etag}` }), status: 412 },
  {
    name: "stale If-Unmodified-Since",
    headers: () => ({ "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" }),
    status: 412,
  },
  {
    name: "If-Match takes precedence over If-Unmodified-Since",
    headers: ({ etag }) => ({
      "if-match": etag,
      "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
    }),
    status: 200,
  },
];
it.each(validators)("handles $name", ({ headers, status }) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const head = yield* request(runtime, narKey, { method: "HEAD" });
      const metadata = {
        etag: Option.getOrThrow(Option.fromNullishOr(head.headers.get("etag"))),
        modified: Option.getOrThrow(Option.fromNullishOr(head.headers.get("last-modified"))),
      };
      const response = yield* request(runtime, narKey, { headers: headers(metadata) });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }),
  ),
);

it("a stale If-Range returns the complete representation", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey, {
        headers: { range: "bytes=1-3", "if-range": '"stale"' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(yield* bodyBytes(response)).toEqual(Array.fromIterable(bytes));
    }),
  ));

it("rechecks If-Range when R2 changes between HEAD and GET", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      const original = yield* Effect.promise(() => bucket.put(narKey, "original-content"));
      const response = yield* request(runtime, narKey, {
        headers: {
          range: "bytes=0-3",
          "if-range": original.httpEtag,
          "x-test-replace-after-head": "1",
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(yield* text(response)).toBe("replacement-content");
    }),
  ));

it.each([
  "cache-v2.narinfo",
  "nar/nonstandard-digest.nar.future",
  "release@2026.narinfo",
  "nar/release+debug.nar.future",
  "nar/%2fsecret.nar",
])("treats cache object names as opaque within the allowed namespace: %s", (key) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      yield* Effect.promise(() => bucket.put(key, "opaque cache content"));
      const response = yield* request(runtime, key);
      expect(response.status).toBe(200);
      expect(yield* text(response)).toBe("opaque cache content");
    }),
  ),
);

it.each(["GET", "HEAD"])("returns a private generic 502 when R2 %s fails", (method) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey, {
        method,
        headers: { "x-test-r2-failure": "1" },
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* text(response)).toBe("");
    }),
  ),
);

it.each(["x-test-cache-match-failure", "x-test-cache-put-failure"])(
  "serves the original bytes when the Cache API fails: %s",
  (fault) =>
    runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime();
        yield* seed(runtime);
        const response = yield* request(runtime, narKey, { headers: { [fault]: "1" } });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("content-length")).toBe("8");
        expect(yield* bodyBytes(response)).toEqual(Array.fromIterable(bytes));
      }),
    ),
);

it("fails closed after a bounded retry when R2 keeps changing", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      yield* seed(runtime);
      const response = yield* request(runtime, narKey, {
        headers: { range: "bytes=0-3", "x-test-replace-after-every-head": "1" },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* text(response)).toBe("");
    }),
  ));

it("does not cache a missing narinfo", () =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      expect((yield* request(runtime, infoKey)).status).toBe(404);
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      yield* Effect.promise(() => bucket.put(infoKey, "StorePath: /nix/store/example\n"));
      const available = yield* request(runtime, infoKey);
      expect(available.status).toBe(200);
      expect(yield* text(available)).toBe("StorePath: /nix/store/example\n");
    }),
  ));

it.each(["PUT", "POST", "DELETE", "OPTIONS"])("rejects reader method %s", (method) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const response = yield* request(runtime, infoKey, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }),
  ),
);

it.each([
  `${infoKey}?bust=1`,
  "other-secret-file",
  "nar/nested/file.nar",
  "nar/",
  "other/file.nar",
])("rejects paths outside the binary cache namespace: %s", (key) =>
  runTest(
    Effect.gen(function* () {
      const runtime = yield* cacheRuntime();
      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("BUCKET"));
      const storedKey = String.split(key, "?")[0] ?? key;
      yield* Effect.promise(() => bucket.put(storedKey, "outside the allowed namespace"));
      expect((yield* request(runtime, key)).status).toBe(404);
    }),
  ),
);

describe("real Nix S3 push and authenticated Worker pull", () => {
  it(
    "preserves exact NAR bytes and rejects incorrect upload and download credentials",
    () =>
      runTest(
        Effect.gen(function* () {
          const runtime = yield* cacheRuntime();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory("tmp", { recursive: true });
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: path.resolve("tmp"),
            prefix: "nix-roundtrip-",
          });
          const inheritedConfig = yield* Config.String("NIX_CONFIG").pipe(Config.withDefault(""));
          const execute = (
            args: ReadonlyArray<string>,
            options: ChildProcess.CommandOptions = {},
          ) =>
            command("nix", args, {
              ...options,
              extendEnv: true,
              env: {
                ...options.env,
                XDG_CACHE_HOME: path.join(directory, "nix-cache"),
                NIX_CONFIG: `${inheritedConfig}\nnarinfo-cache-positive-ttl = 0\nnarinfo-cache-negative-ttl = 0\n`,
              },
            });
          const nix = (args: ReadonlyArray<string>, options?: ChildProcess.CommandOptions) =>
            execute(args, options).pipe(
              Effect.tap((result) =>
                Effect.sync(() => expect(result.exitCode, result.stderr).toBe(0)),
              ),
            );
          const content = Schema.encodeSync(Schema.fromJsonString(Schema.String))(
            `authenticated roundtrip ${directory}\n`,
          );
          const { stdout: storePath } = yield* nix([
            "eval",
            "--raw",
            "--expr",
            `builtins.toFile "nix-cache-probe" ${content}`,
          ]);
          const url = yield* Effect.promise(() => runtime.ready);
          // Nix's store prefix preserves Miniflare's native S3 canonical URL, without a proxy or mock.
          const s3 = `s3://cdn-cgi/local/r2/s3/test-cache?scheme=http&endpoint=${url.host}&region=auto&compression=zstd`;
          const credentials = {
            AWS_ACCESS_KEY_ID: "local-test-access-key",
            AWS_SECRET_ACCESS_KEY: "local-test-secret-key",
            AWS_SESSION_TOKEN: "",
            AWS_EC2_METADATA_DISABLED: "true",
          };
          const deniedUpload = yield* execute(["copy", "--to", s3, storePath], {
            env: { ...credentials, AWS_SECRET_ACCESS_KEY: "incorrect" },
          });
          expect(deniedUpload.exitCode).not.toBe(0);
          yield* nix(["copy", "--to", s3, storePath], { env: credentials });
          const netrc = path.join(directory, "netrc");
          const wrongNetrc = path.join(directory, "wrong-netrc");
          yield* fs.writeFileString(
            netrc,
            `machine ${url.hostname}\nlogin reader\npassword test-secret\n`,
            { mode: 0o600, flag: "wx" },
          );
          yield* fs.writeFileString(
            wrongNetrc,
            `machine ${url.hostname}\nlogin reader\npassword incorrect\n`,
            { mode: 0o600, flag: "wx" },
          );
          const deniedPull = yield* execute([
            "store",
            "dump-path",
            "--store",
            url.href,
            "--option",
            "netrc-file",
            wrongNetrc,
            storePath,
          ]);
          expect(deniedPull.exitCode).not.toBe(0);
          const pulled = (yield* path.toFileUrl(path.join(directory, "pulled"))).href;
          yield* nix([
            "copy",
            "--from",
            url.href,
            "--to",
            pulled,
            "--option",
            "netrc-file",
            netrc,
            storePath,
          ]);
          const expected = yield* nix(["store", "dump-path", storePath]);
          const actual = yield* nix(["store", "dump-path", "--store", pulled, storePath]);
          expect(actual.stdoutBytes).toEqual(expected.stdoutBytes);
        }),
      ),
    60_000,
  );
});
