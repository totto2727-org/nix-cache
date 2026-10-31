import { Array, Effect, FileSystem, Path, Record, String } from "effect";
import { Base64 } from "effect/encoding";
import { expect, it } from "vite-plus/test";
import { miniflare, runTest } from "./support";

it("the compiled Alchemy Worker authenticates before reading its R2 binding", () =>
  runTest(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.resolve("dist/ssr");
      const files = Array.filter(
        yield* fs.readDirectory(directory, { recursive: true }),
        String.endsWith(".js"),
      );
      const modules = Record.fromEntries(
        yield* Effect.forEach(files, (name) =>
          Effect.map(
            fs.readFileString(path.join(directory, name)),
            (contents) => [name, { type: "esm" as const, contents }] as const,
          ),
        ),
      );
      const runtime = yield* miniflare({
        workers: [
          {
            config: {
              name: "built-worker",
              compatibilityDate: "2026-09-25",
              compatibilityFlags: ["nodejs_compat"],
              manifest: { mainModule: "index.js", modules },
              env: {
                ALCHEMY_STACK_NAME: { type: "text", value: "nix-cache" },
                ALCHEMY_STAGE: { type: "text", value: "test" },
                NIX_CACHE_USERNAME: { type: "text", value: "reader" },
                NIX_CACHE_PASSWORD: { type: "text", value: "test-secret" },
                "nix-cache-objects": { type: "r2", name: "built-smoke" },
              },
            },
          },
        ],
      });
      // Dispatch and response objects belong to the real workerd test boundary.
      const unauthorized = yield* Effect.promise(() =>
        runtime.dispatchFetch("https://cache.test/nix-cache-info"),
      );
      expect(unauthorized.status).toBe(401);
      // Identity encoding makes byte-length checks independent of edge compression.
      const authorized = yield* Effect.promise(() =>
        runtime.dispatchFetch("https://cache.test/nix-cache-info", {
          headers: {
            authorization: `Basic ${Base64.encode("reader:test-secret")}`,
            "accept-encoding": "identity",
          },
        }),
      );
      expect(authorized.status).toBe(404);
      expect(authorized.headers.get("cache-control")).toBe("private, no-store");

      const bucket = yield* Effect.promise(() => runtime.getR2Bucket("nix-cache-objects"));
      const content = "StoreDir: /nix/store\n";
      yield* Effect.promise(() => bucket.put("nix-cache-info", content));
      const fetched = yield* Effect.promise(() =>
        runtime.dispatchFetch("https://cache.test/nix-cache-info", {
          headers: {
            authorization: `Basic ${Base64.encode("reader:test-secret")}`,
            "accept-encoding": "identity",
          },
        }),
      );
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-length")).toBe(`${content.length}`);
      expect(fetched.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* Effect.promise(() => fetched.text())).toBe(content);

      yield* Effect.promise(() => bucket.delete("nix-cache-info"));
      const warm = yield* Effect.promise(() =>
        runtime.dispatchFetch("https://cache.test/nix-cache-info", {
          headers: {
            authorization: `Basic ${Base64.encode("reader:test-secret")}`,
            "accept-encoding": "identity",
          },
        }),
      );
      expect(warm.status).toBe(200);
      expect(warm.headers.get("content-length")).toBe(`${content.length}`);
      expect(warm.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* Effect.promise(() => warm.text())).toBe(content);
      const warmUnauthorized = yield* Effect.promise(() =>
        runtime.dispatchFetch("https://cache.test/nix-cache-info"),
      );
      expect(warmUnauthorized.status).toBe(401);
    }),
  ));
