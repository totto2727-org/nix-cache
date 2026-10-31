import type * as CF from "@cloudflare/workers-types";
import { R2Error } from "alchemy/Cloudflare/R2";
import { Effect, Layer, Redacted, Stream } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import { CacheBucket, CacheReader, CacheRoutes, CacheStorage } from "../src/cache";
import { makeResponseCache } from "../src/cloudflare-storage";

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
    // The native test runtime has no Alchemy host. Only the fixture bridges
    // its R2 binding into the Alchemy-shaped metadata and stream capabilities.
    const r2 = <A>(evaluate: () => Promise<A>) =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => new R2Error({ message: "Injected R2 failure", cause: cause as Error }),
      });
    const cache = (globalThis.caches as unknown as CF.CacheStorage).default;
    const routes = CacheRoutes.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(CacheBucket, {
            head: (key) => r2(() => bucket.head(key)),
            get: (key, options) =>
              r2(() => bucket.get(key, options)).pipe(
                Effect.map((object) => {
                  if (object === null || !("body" in object)) return object;
                  const readable = object.body as unknown as ReadableStream<Uint8Array>;
                  return {
                    ...object,
                    readable,
                    body: Stream.fromReadableStream({
                      evaluate: () => readable,
                      onError: (cause) =>
                        new R2Error({
                          message: "Injected R2 stream failure",
                          cause: cause as Error,
                        }),
                    }),
                  };
                }),
              ),
          }),
          Layer.succeed(
            CacheStorage,
            makeResponseCache({
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
