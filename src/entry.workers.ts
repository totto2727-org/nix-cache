import * as Cloudflare from 'alchemy/Cloudflare'
import { WorkerExecutionContext } from 'alchemy/Cloudflare/Workers'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Config, Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'

import { CacheBucket } from './cache-bucket.ts'
import { CacheReader } from './cache-reader.ts'
import { CacheRoutes } from './cache.ts'
import { CacheStorage, defaultNativeCache, makeResponseCache } from './cloudflare-storage.ts'
import { bucketId, workerId, workerProps } from './worker-settings.ts'

export class Worker extends Cloudflare.Worker<Worker, Cloudflare.WorkerShape>()(workerId) {}

// oxlint-disable-next-line import/no-default-export -- The Alchemy bundler loads the Worker resource from the entry module default.
export default Worker.make(
  workerProps,
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket(bucketId, {
      domains: [],
      forceDestroy: false,
      publicAccess: false,
    })
    const accountId = yield* bucket.accountId
    const bucketName = yield* bucket.bucketName
    const reader = yield* Cloudflare.R2.ReadBucket(bucket).pipe(Effect.provide(Cloudflare.R2.ReadBucketBinding))
    // Alchemy binds Config.Redacted reads as secret_text, not public build-time defines.
    const username = yield* Config.Redacted('NIX_CACHE_USERNAME')
    const password = yield* Config.Redacted('NIX_CACHE_PASSWORD')

    return {
      fetch: Effect.gen(function* () {
        // Alchemy clients resolve deferred bindings against this live request context.
        const runtime = yield* RuntimeContext
        const context = yield* WorkerExecutionContext
        const responseCache = makeResponseCache({
          // Explicit Cache API access is required after endpoint authentication.
          cache: defaultNativeCache(),
          waitUntil: (promise: Promise<unknown>) => {
            context.raw.waitUntil(promise)
          },
        })
        const readerConfig = {
          cacheNamespace: `${yield* accountId}/${yield* bucketName}`,
          password,
          username,
        }
        const services = Layer.mergeAll(
          Layer.succeed(CacheBucket, reader),
          Layer.succeed(RuntimeContext, runtime),
          Layer.succeed(CacheStorage, responseCache),
          Layer.succeed(CacheReader, readerConfig),
        )
        const routes = CacheRoutes.pipe(HttpRouter.provideRequest(services))
        const http = yield* HttpRouter.toHttpEffect(routes)
        return yield* http
      }).pipe(Effect.orDie),
    }
  }),
)
