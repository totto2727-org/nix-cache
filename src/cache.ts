import type { ObjectBody, R2Error, R2Object } from 'alchemy/Cloudflare/R2'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Array, Data, Effect, Option, Predicate, Record, Redacted, String } from 'effect'
import type { Crypto } from 'effect'
import { Base64 } from 'effect/encoding'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { CacheBucket } from './cache-bucket.ts'
import { CacheReader } from './cache-reader.ts'
import { CacheStorage, credentialsMatch, httpDate, objectResponse, uploaded } from './cloudflare-storage.ts'
import { dateAtLeast, dateBefore, matchesEtag, objectKey, parseRange } from './http-policy.ts'
import type { ByteRange } from './http-policy.ts'

const secondsPerMinute = 60
const minutesPerHour = 60
const hoursPerDay = 24
const daysPerYear = 365
const narTtlSeconds = daysPerYear * hoursPerDay * minutesPerHour * secondsPerMinute
const cacheInfoTtlSeconds = secondsPerMinute
const narinfoTtlMinutes = 5
const narinfoTtlSeconds = narinfoTtlMinutes * secondsPerMinute

const Status = {
  badGateway: 502,
  methodNotAllowed: 405,
  notFound: 404,
  notModified: 304,
  ok: 200,
  partialContent: 206,
  preconditionFailed: 412,
  rangeNotSatisfiable: 416,
  unauthorized: 401,
  unavailable: 503,
}
const inclusiveEndpointWidth = 1

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' }
const reply = (status: number, headers?: Readonly<Record<string, string>>): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ headers: { ...headers, ...privateHeaders }, status })

// All responses are private to the authenticated caller, including failures and cache hits.
const privateResponse = (
  response: HttpServerResponse.HttpServerResponse,
  method: string,
): HttpServerResponse.HttpServerResponse =>
  method === 'HEAD' ? reply(response.status, response.headers) : HttpServerResponse.setHeaders(response, privateHeaders)

interface ReadPlan {
  range: Option.Option<ByteRange>
  expectedEtag: Option.Option<string>
  headers: Readonly<Record<string, string>>
}
type ReadPreparation = Data.TaggedEnum<{
  Read: { plan: ReadPlan }
  Reply: { response: HttpServerResponse.HttpServerResponse }
}>
const Preparation = Data.taggedEnum<ReadPreparation>()
const isReply = Preparation.$is('Reply')
const replyTo = (response: HttpServerResponse.HttpServerResponse): ReadPreparation => Preparation.Reply({ response })

interface ObjectRequest {
  cacheKey: string
  conditional: boolean
  key: string
  rangeHeader: string | undefined
  request: HttpServerRequest.HttpServerRequest
}

const contentType = (key: string): string =>
  String.startsWith('nar/')(key) ? 'application/octet-stream' : 'text/plain'

const canUseCache = ({ conditional, rangeHeader }: ObjectRequest): boolean =>
  !conditional && Predicate.isNullish(rangeHeader)

const isPreconditionFailed = ({ headers }: HttpServerRequest.HttpServerRequest, metadata: R2Object): boolean => {
  const ifMatch = headers['if-match']
  if (Predicate.isNotNullish(ifMatch)) {
    return !matchesEtag(ifMatch, metadata.httpEtag)
  }
  const unmodifiedSince = headers['if-unmodified-since']
  return Predicate.isNotNullish(unmodifiedSince) && dateBefore(unmodifiedSince, uploaded(metadata))
}

const isNotModified = ({ headers }: HttpServerRequest.HttpServerRequest, metadata: R2Object): boolean => {
  const ifNoneMatch = headers['if-none-match']
  if (Predicate.isNotNullish(ifNoneMatch)) {
    return matchesEtag(ifNoneMatch, metadata.httpEtag, true)
  }
  const modifiedSince = headers['if-modified-since']
  return Predicate.isNotNullish(modifiedSince) && dateAtLeast(modifiedSince, uploaded(metadata))
}

const rangedRead = (rangeHeader: string, metadata: R2Object, headers: ReadPlan['headers']): ReadPreparation => {
  const range = parseRange(rangeHeader, metadata.size)
  if (Option.isNone(range)) {
    return replyTo(reply(Status.rangeNotSatisfiable, { 'Content-Range': `bytes */${metadata.size}` }))
  }
  const { offset, length } = range.value
  const endpoint = offset + length - inclusiveEndpointWidth
  return Preparation.Read({
    plan: {
      expectedEtag: Option.some(metadata.etag),
      headers: { ...headers, 'Content-Range': `bytes ${offset}-${endpoint}/${metadata.size}` },
      range,
    },
  })
}

const acceptRanges = { 'Accept-Ranges': 'bytes' }

const acceptsRange = (ifRange: string | undefined, metadata: R2Object): boolean =>
  Predicate.isNullish(ifRange) || ifRange === metadata.httpEtag || dateAtLeast(ifRange, uploaded(metadata))

const prepareWithMetadata = ({ request, key, rangeHeader }: ObjectRequest, metadata: R2Object): ReadPreparation => {
  const validators = { ...acceptRanges, ETag: metadata.httpEtag, 'Last-Modified': httpDate(uploaded(metadata)) }
  if (isPreconditionFailed(request, metadata)) {
    return replyTo(reply(Status.preconditionFailed))
  }
  if (isNotModified(request, metadata)) {
    return replyTo(reply(Status.notModified, validators))
  }
  if (request.method === 'HEAD') {
    return replyTo(
      reply(Status.ok, {
        ...validators,
        'Content-Length': `${metadata.size}`,
        'Content-Type': contentType(key),
      }),
    )
  }
  if (Predicate.isNotNullish(rangeHeader) && acceptsRange(request.headers['if-range'], metadata)) {
    return rangedRead(rangeHeader, metadata, validators)
  }
  return Preparation.Read({
    plan: { expectedEtag: Option.some(metadata.etag), headers: validators, range: Option.none() },
  })
}

const prepare = (input: ObjectRequest): Effect.Effect<ReadPreparation, R2Error, CacheBucket | RuntimeContext> =>
  Effect.gen(function* () {
    if (input.request.method !== 'HEAD' && canUseCache(input)) {
      return Preparation.Read({
        plan: { expectedEtag: Option.none(), headers: acceptRanges, range: Option.none() },
      })
    }
    const bucket = yield* CacheBucket
    const metadata = yield* bucket.head(input.key)
    return metadata ? prepareWithMetadata(input, metadata) : replyTo(reply(Status.notFound))
  })

const ttlFor = (key: string): number => {
  if (String.startsWith('nar/')(key)) {
    return narTtlSeconds
  }
  return key === 'nix-cache-info' ? cacheInfoTtlSeconds : narinfoTtlSeconds
}

const serveObject = (
  input: ObjectRequest,
  plan: ReadPlan,
  object: ObjectBody,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, CacheStorage> =>
  Effect.gen(function* () {
    const contentLength = Option.match(plan.range, {
      onNone: () => object.size,
      onSome: (range) => range.length,
    })
    const response = objectResponse(object, {
      contentLength,
      headers: {
        ...plan.headers,
        'Cache-Control': `public, max-age=${ttlFor(input.key)}`,
        'Content-Length': `${contentLength}`,
        'Content-Type': contentType(input.key),
        ETag: object.httpEtag,
        'Last-Modified': httpDate(uploaded(object)),
      },
      status: Option.isSome(plan.range) ? Status.partialContent : Status.ok,
    })
    if (canUseCache(input) && input.request.method === 'GET') {
      const cache = yield* CacheStorage
      return privateResponse(yield* cache.put(input.cacheKey, response), input.request.method)
    }
    return privateResponse(response, input.request.method)
  })

const readObject = (
  input: ObjectRequest,
  retryOnReplacement = true,
): Effect.Effect<HttpServerResponse.HttpServerResponse, R2Error, CacheBucket | CacheStorage | RuntimeContext> =>
  Effect.gen(function* () {
    const bucket = yield* CacheBucket
    const prepared = yield* prepare(input)
    if (isReply(prepared)) {
      return prepared.response
    }
    const object = yield* bucket.get(input.key, {
      ...(Option.isSome(prepared.plan.expectedEtag)
        ? { onlyIf: { etagMatches: prepared.plan.expectedEtag.value } }
        : {}),
      ...(Option.isSome(prepared.plan.range) ? { range: prepared.plan.range.value } : {}),
    })
    if (!object) {
      return reply(Status.notFound)
    }
    // Re-evaluate metadata once if the object changed between HEAD and GET.
    if (!('body' in object)) {
      return retryOnReplacement ? yield* readObject(input, false) : reply(Status.unavailable)
    }
    return yield* serveObject(input, prepared.plan, object)
  })

const authorize = (
  request: HttpServerRequest.HttpServerRequest,
  username: string,
  password: string,
): Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    if (String.isEmpty(username) || String.isEmpty(password) || String.includes(':')(username)) {
      return Option.some(reply(Status.unavailable))
    }
    const expected = `Basic ${Base64.encode(`${username}:${password}`)}`
    const matched = yield* Effect.option(credentialsMatch(request.headers['authorization'] ?? '', expected))
    if (Option.isNone(matched)) {
      return Option.some(reply(Status.unavailable))
    }
    if (!matched.value) {
      return Option.some(reply(Status.unauthorized, { 'WWW-Authenticate': 'Basic realm="nix-cache", charset="UTF-8"' }))
    }
    return request.method === 'GET' || request.method === 'HEAD'
      ? Option.none()
      : Option.some(reply(Status.methodNotAllowed, { Allow: 'GET, HEAD' }))
  })

const resolveObject = (
  request: HttpServerRequest.HttpServerRequest,
  namespace: string,
): Option.Option<ObjectRequest> => {
  const url = HttpServerRequest.toURL(request)
  if (Option.isNone(url) || String.isNonEmpty(url.value.search)) {
    return Option.none()
  }
  // Encode both components so the Cache API preserves opaque R2 percent-encoded keys.
  return Option.map(objectKey(url.value.pathname), (key) => ({
    cacheKey: `https://nix-cache.internal/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
    conditional: Array.some(Record.keys<string, string>(request.headers), String.startsWith('if-')),
    key,
    rangeHeader: request.method === 'GET' ? request.headers['range'] : undefined,
    request,
  }))
}

const readCachedObject = (
  input: ObjectRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, R2Error, CacheStorage | CacheBucket | RuntimeContext> =>
  Effect.gen(function* () {
    if (canUseCache(input)) {
      const storage = yield* CacheStorage
      const cached = yield* storage.match(input.cacheKey)
      if (Option.isSome(cached)) {
        return privateResponse(cached.value, input.request.method)
      }
    }
    return yield* readObject(input)
  })

const cacheObject = Effect.gen(function* () {
  const reader = yield* CacheReader
  const request = yield* HttpServerRequest.HttpServerRequest
  const denied = yield* authorize(request, Redacted.value(reader.username), Redacted.value(reader.password))
  if (Option.isSome(denied)) {
    return denied.value
  }
  const input = resolveObject(request, reader.cacheNamespace)
  return Option.isSome(input) ? yield* readCachedObject(input.value) : reply(Status.notFound)
}).pipe(Effect.catchTag('R2Error', () => Effect.succeed(reply(Status.badGateway))))

/** Concrete read endpoints, with storage and reader settings supplied by the entry point. */
export const CacheRoutes = HttpRouter.addAll([
  HttpRouter.route('*', '/nix-cache-info', cacheObject),
  HttpRouter.route('*', '/:narinfo', cacheObject),
  HttpRouter.route('*', '/nar/:nar', cacheObject),
  HttpRouter.route('*', '/*', reply(Status.notFound)),
])
