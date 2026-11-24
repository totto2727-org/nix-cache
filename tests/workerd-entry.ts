import type * as CF from '@cloudflare/workers-types'
import { makeRead, R2Error } from 'alchemy/Cloudflare/R2'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Data, Effect, Layer, Predicate, Redacted } from 'effect'
import { HttpEffect, HttpRouter } from 'effect/http'

// Alchemy ships this helper but omits its public package export.
// Keep the installed-module import confined to the native acceptance fixture.
// oxlint-disable-next-line rules/consistent-import-extension, import/no-relative-parent-imports -- Alchemy publishes this test adapter as JavaScript and omits its package export.
import { makeR2ObjectWrappers } from '../node_modules/alchemy/lib/Cloudflare/R2/BucketBinding.js'
// oxlint-disable-next-line import/no-relative-parent-imports -- The workerd acceptance entry injects native bindings into the application module.
import { CacheBucket } from '../src/cache-bucket.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- The workerd acceptance entry injects native bindings into the application module.
import { CacheReader } from '../src/cache-reader.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- The workerd acceptance entry injects native bindings into the application module.
import { CacheRoutes } from '../src/cache.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- The workerd acceptance entry injects native bindings into the application module.
import { CacheStorage, defaultNativeCache, makeResponseCache } from '../src/cloudflare-storage.ts'

class InjectedFailure extends Data.TaggedError('InjectedFailure')<{ message: string }> {}

const r2 = <A>(evaluate: () => Promise<A>): Effect.Effect<A, R2Error> =>
  Effect.tryPromise({
    catch: (cause) =>
      new R2Error({
        cause: Predicate.isError(cause) ? cause : new InjectedFailure({ message: 'Non-Error rejection from R2' }),
        message: 'Injected R2 failure',
      }),
    try: evaluate,
  })

// oxlint-disable-next-line typescript/require-await -- The injected R2 method must reject asynchronously like the native binding.
const rejectR2 = async (): Promise<never> => {
  throw new InjectedFailure({ message: 'Injected private R2 failure' })
}

const replaceObject = ({
  target,
  replaceAlways,
}: {
  target: CF.R2Bucket
  replaceAlways: boolean
}): ((key: string) => Promise<CF.R2Object | null>) => {
  const replacements = { count: 0 }
  return async (key) => {
    const previous = await target.head(key)
    const firstReplacement = 0
    if (replaceAlways || replacements.count === firstReplacement) {
      replacements.count += 1
      await target.put(key, replaceAlways ? `replacement-content-${replacements.count}` : 'replacement-content')
    }
    return previous
  }
}

const bucketFor = (request: Request, bucket: CF.R2Bucket): CF.R2Bucket => {
  const replaceOnce = request.headers.has('x-test-replace-after-head')
  const replaceAlways = request.headers.has('x-test-replace-after-every-head')
  const failR2 = request.headers.has('x-test-r2-failure')
  if (!(replaceOnce || replaceAlways || failR2)) {
    return bucket
  }
  const head = replaceObject({ replaceAlways, target: bucket })
  return new Proxy(bucket, {
    get(target, property): unknown {
      if (failR2 && (property === 'head' || property === 'get')) {
        return rejectR2
      }
      if (property === 'head') {
        return head
      }
      const value: unknown = Reflect.get(target, property, target)
      return Predicate.isFunction(value) ? value.bind(target) : value
    },
  })
}

const injectedCache = (request: Request, context: CF.ExecutionContext): ReturnType<typeof makeResponseCache> => {
  const cache = defaultNativeCache()
  return makeResponseCache({
    cache: {
      async match(key, options) {
        if (request.headers.has('x-test-cache-match-failure')) {
          throw new InjectedFailure({ message: 'Injected private cache read failure' })
        }
        return cache.match(key, options)
      },
      async put(key, response) {
        if (request.headers.has('x-test-cache-put-failure')) {
          throw new InjectedFailure({ message: 'Injected private cache write failure' })
        }
        return cache.put(key, response)
      },
    },
    waitUntil: (promise) => {
      context.waitUntil(promise)
    },
  })
}

const workerd = {
  async fetch(request: Request, env: { BUCKET: CF.R2Bucket }, context: CF.ExecutionContext): Promise<Response> {
    const bucket = bucketFor(request, env.BUCKET)
    const reader = makeRead({
      raw: Effect.succeed(bucket),
      ...makeR2ObjectWrappers(r2),
      tryPromise: r2,
      use: (evaluate) => r2(async () => evaluate(bucket)),
    })
    const settings = {
      cacheNamespace: request.headers.get('x-test-cache-namespace') ?? 'local-test-bucket',
      password: Redacted.make('test-secret'),
      username: Redacted.make('reader'),
    }
    // Alchemy's direct test client does not resolve a host RuntimeContext.
    const services = Layer.mergeAll(
      Layer.succeed(CacheBucket, reader),
      RuntimeContext.phantom,
      Layer.succeed(CacheStorage, injectedCache(request, context)),
      Layer.succeed(CacheReader, settings),
    )
    const routes = CacheRoutes.pipe(HttpRouter.provideRequest(services))
    const handle = HttpEffect.toWebHandler(
      Effect.gen(function* () {
        const http = yield* HttpRouter.toHttpEffect(routes)
        return yield* http
      }),
    )
    return handle(request)
  },
}

// oxlint-disable-next-line import/no-default-export -- Workerd loads the fetch handler from the module default.
export default workerd
