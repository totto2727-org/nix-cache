import type * as CF from "@cloudflare/workers-types";
import { Effect, Layer, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import { CacheReader, CacheRoutes, CacheStorage } from "../src/cache";
import { makeStorage } from "../src/cloudflare-storage";

export default {
  // Native Request/Promise/proxy operations are confined to this workerd test
  // adapter, where fault headers simulate failures of real Cloudflare bindings.
  fetch(request: Request, env: { BUCKET: CF.R2Bucket }, context: CF.ExecutionContext) {
    let replacements = 0;
    const replaceOnce = request.headers.has("x-test-replace-after-head");
    const replaceAlways = request.headers.has("x-test-replace-after-every-head");
    const failR2 = request.headers.has("x-test-r2-failure");
    const bucket =
      replaceOnce || replaceAlways || failR2
        ? new Proxy(env.BUCKET, {
            get(target, property) {
              if (failR2 && (property === "head" || property === "get"))
                return async () => {
                  throw new Error("Injected private R2 failure");
                };
              if (property === "head")
                return async (key: string) => {
                  const previous = await target.head(key);
                  if (replaceAlways || replacements === 0) {
                    replacements += 1;
                    await target.put(
                      key,
                      replaceAlways ? `replacement-content-${replacements}` : "replacement-content",
                    );
                  }
                  return previous;
                };
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        : env.BUCKET;
    const cache = (globalThis.caches as unknown as CF.CacheStorage).default;
    const routes = CacheRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(
            CacheStorage,
            makeStorage({
              bucket,
              cache: {
                async match(key, options) {
                  if (request.headers.has("x-test-cache-match-failure"))
                    throw new Error("Injected private cache read failure");
                  return cache.match(key, options);
                },
                async put(key, response) {
                  if (request.headers.has("x-test-cache-put-failure"))
                    throw new Error("Injected private cache write failure");
                  return cache.put(key, response);
                },
              },
              waitUntil: (promise) => context.waitUntil(promise),
            }),
          ),
          Layer.succeed(CacheReader, {
            cacheNamespace: request.headers.get("x-test-cache-namespace") ?? "local-test-bucket",
            username: Redacted.make("reader"),
            password: Redacted.make("test-secret"),
          }),
        ),
      ),
    );
    return HttpEffect.toWebHandler(
      Effect.gen(function* () {
        const http = yield* HttpRouter.toHttpEffect(routes);
        return yield* http;
      }),
    )(request);
  },
};
