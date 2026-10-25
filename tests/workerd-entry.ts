import type * as CF from "@cloudflare/workers-types";
import { Redacted } from "effect";
import { HttpEffect } from "effect/http";
import { makeCacheHttpEffect } from "../src/cache";

export default {
  fetch(request: Request, env: { BUCKET: CF.R2Bucket }, context: CF.ExecutionContext) {
    let replaced = false;
    const bucket = request.headers.has("x-test-replace-after-head")
      ? new Proxy(env.BUCKET, {
          get(target, property) {
            if (property === "head")
              return async (key: string) => {
                const previous = await target.head(key);
                if (!replaced) {
                  replaced = true;
                  await target.put(key, "replacement-content");
                }
                return previous;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : env.BUCKET;
    return HttpEffect.toWebHandler(
      makeCacheHttpEffect({
        bucket,
        cacheNamespace: "local-test-bucket",
        cache: (globalThis.caches as unknown as CF.CacheStorage).default,
        waitUntil: (promise) => context.waitUntil(promise),
        username: Redacted.make("reader"),
        password: Redacted.make("test-secret"),
      }),
    )(request);
  },
};
