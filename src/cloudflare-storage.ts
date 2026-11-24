import type * as CF from '@cloudflare/workers-types'
import { BrowserCrypto } from '@effect/platform-browser'
import type { ObjectBody, R2Object } from 'alchemy/Cloudflare/R2'
import { Cause, Context, Crypto, DateTime, Effect, Option, Predicate, Schema } from 'effect'
import type { Layer, PlatformError } from 'effect'
import { HttpServerResponse } from 'effect/http'

// Workerd supplies the Web Crypto API used by Effect's platform layer.
export const workerCryptoLayer: Layer.Layer<Crypto.Crypto> = BrowserCrypto.layer

// SHA-256 produces equal-length digests of the UTF-8 credentials.
// Workerd supplies the native timingSafeEqual extension to SubtleCrypto.
export const credentialsMatch = (
  supplied: string,
  expected: string,
): Effect.Effect<boolean, PlatformError.PlatformError | Cause.UnknownError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const cryptography = yield* Crypto.Crypto
    const encoder = new TextEncoder()
    const [suppliedDigest, expectedDigest] = yield* Effect.all(
      [
        cryptography.digest('SHA-256', encoder.encode(supplied)),
        cryptography.digest('SHA-256', encoder.encode(expected)),
      ],
      { concurrency: 'unbounded' },
    )
    return yield* Effect.try(() => {
      const subtle: SubtleCrypto & Partial<Pick<CF.SubtleCrypto, 'timingSafeEqual'>> = crypto.subtle
      if (!Predicate.isFunction(subtle.timingSafeEqual)) {
        throw new Cause.UnknownError(undefined, 'Workerd timingSafeEqual is unavailable')
      }
      return subtle.timingSafeEqual(suppliedDigest, expectedDigest)
    })
  })

export const uploaded = (object: Pick<R2Object, 'uploaded'>): DateTime.Utc => DateTime.fromDateUnsafe(object.uploaded)

// Effect has no HTTP IMF-fixdate formatter. Date conversion stays here, solely
// For the RFC 9110 wire representation, never for comparisons or parsing.
export const httpDate = (value: DateTime.Utc): string => DateTime.toDateUtc(value).toUTCString()

// FromWeb converts bodies into Effect Streams. Workerd then loses the native
// Fixed-length stream marker and drops Content-Length. Preserve the native body
// Only at this adapter, with explicit Effect body metadata for header updates.
const contentLengthFromHeader = Schema.decodeUnknownOption(Schema.NumberFromString)

const fromCloudflare = (response: Response): HttpServerResponse.HttpServerResponse => {
  const contentLength = contentLengthFromHeader(response.headers.get('content-length'))
  return HttpServerResponse.raw(response.body, {
    contentLength: Option.getOrUndefined(contentLength),
    contentType: response.headers.get('content-type') ?? undefined,
    headers: response.headers,
    status: response.status,
  })
}

export const defaultNativeCache = (): CF.Cache =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Workerd adds the default cache to the standard CacheStorage interface.
  (globalThis.caches as unknown as CF.CacheStorage).default

interface ResponseCache {
  match: (key: string) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>
  put: (
    key: string,
    response: HttpServerResponse.HttpServerResponse,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}
interface ResponseCacheOptions {
  cache: Pick<CF.Cache, 'match' | 'put'>
  waitUntil: (promise: Promise<unknown>) => void
}

const fromNativeResponse = (response: CF.Response): HttpServerResponse.HttpServerResponse =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Worker Cache and the global HTTP runtime expose the same native Response with different ambient types.
  fromCloudflare(response as unknown as Response)

export const makeResponseCache = (options: ResponseCacheOptions): ResponseCache => ({
  match: (key: string) =>
    Effect.tryPromise(async () => options.cache.match(key)).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.map(Option.map(fromNativeResponse)),
      Effect.orElseSucceed(() => Option.none()),
    ),
  // Cache API needs a cloneable native Response and waitUntil needs a Promise.
  // Tee only here, retaining streaming and the Effect response in the core.
  put: (key: string, response: HttpServerResponse.HttpServerResponse) =>
    Effect.sync(() => {
      const web = HttpServerResponse.toWeb(response)
      const cached = web.clone()
      const write = Effect.tryPromise(async () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cache.put accepts this exact workerd Response; the global and Cloudflare types are declared separately.
        await options.cache.put(key, cached as unknown as CF.Response)
      })
      const reportedWrite = write.pipe(
        Effect.tapError(() => Effect.logWarning('Nix cache write failed')),
        Effect.ignore,
      )
      // oxlint-disable-next-line rules/no-effect-runtime-run -- Workerd waitUntil owns the background cache write and requires a Promise.
      const pendingWrite = Effect.runPromise(reportedWrite)
      options.waitUntil(pendingWrite)
      return fromCloudflare(web)
    }),
})

// Alchemy exposes the original R2 readable for zero-copy native HTTP forwarding.
// Effect stream fallback supports clients without a native stream, without buffering.
interface ObjectResponseOptions {
  headers: Readonly<Record<string, string>>
  status: number
  contentLength: number
}

export const objectResponse = (
  object: Pick<ObjectBody, 'readable' | 'body'>,
  { headers, status, contentLength }: ObjectResponseOptions,
): HttpServerResponse.HttpServerResponse => {
  const options = { contentLength, contentType: headers['Content-Type'], headers, status }
  return Predicate.isNullish(object.readable)
    ? HttpServerResponse.stream(object.body, options)
    : HttpServerResponse.raw(object.readable, options)
}

export class CacheStorage extends Context.Service<CacheStorage, ResponseCache>()('nix-cache/ResponseCache') {}
