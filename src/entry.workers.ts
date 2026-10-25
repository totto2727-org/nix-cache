import type { CacheStorage } from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import { WorkerExecutionContext } from "alchemy/Cloudflare/Workers";
import { Config, Effect } from "effect";
import { makeCacheHttpEffect } from "./cache";

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
        const bucket = yield* reader.raw;
        const context = yield* WorkerExecutionContext;
        return yield* makeCacheHttpEffect({
          bucket,
          cacheNamespace: `${yield* accountId}/${yield* bucketName}`,
          cache: (globalThis.caches as unknown as CacheStorage).default,
          waitUntil: (promise: Promise<unknown>) => context.raw.waitUntil(promise),
          username,
          password,
        });
      }).pipe(Effect.orDie),
    };
  }),
);
