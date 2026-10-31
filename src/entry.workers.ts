import type { CacheStorage as NativeCacheStorage } from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import { WorkerExecutionContext } from "alchemy/Cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { CacheBucket, CacheReader, CacheRoutes, CacheStorage } from "./cache";
import { makeResponseCache } from "./cloudflare-storage";

export class Worker extends Cloudflare.Worker<Worker, Cloudflare.WorkerShape>()(
  "nix-cache-reader",
) {}

export default Worker.make(
  {
    main: import.meta.url,
    compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
    vite: {},
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("nix-cache-objects", {
      publicAccess: false,
      domains: [],
      forceDestroy: false,
    });
    const accountId = yield* bucket.accountId;
    const bucketName = yield* bucket.bucketName;
    const reader = yield* Cloudflare.R2.ReadBucket(bucket).pipe(
      Effect.provide(Cloudflare.R2.ReadBucketBinding),
    );
    // Alchemy binds Config.Redacted reads as secret_text, not public build-time defines.
    const username = yield* Config.Redacted("NIX_CACHE_USERNAME");
    const password = yield* Config.Redacted("NIX_CACHE_PASSWORD");

    return {
      fetch: Effect.gen(function* () {
        // Alchemy clients resolve deferred bindings against this live request context.
        const runtime = yield* Effect.context<RuntimeContext>();
        const context = yield* WorkerExecutionContext;
        const routes = CacheRoutes.pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(CacheBucket, {
                head: (key) => reader.head(key).pipe(Effect.provideContext(runtime)),
                get: (key, options) =>
                  reader.get(key, options).pipe(Effect.provideContext(runtime)),
              }),
              Layer.succeed(
                CacheStorage,
                makeResponseCache({
                  // Workers Cache checks before fetch and only exposes purge, so
                  // explicit Cache API access is required after endpoint authentication.
                  cache: (globalThis.caches as unknown as NativeCacheStorage).default,
                  waitUntil: (promise: Promise<unknown>) => context.raw.waitUntil(promise),
                }),
              ),
              Layer.succeed(CacheReader, {
                cacheNamespace: `${yield* accountId}/${yield* bucketName}`,
                username,
                password,
              }),
            ),
          ),
        );
        const http = yield* HttpRouter.toHttpEffect(routes);
        return yield* http;
      }).pipe(Effect.orDie),
    };
  }),
);
