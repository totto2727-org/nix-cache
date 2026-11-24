import { Array, Effect, Option, String } from 'effect'
import { Base64 } from 'effect/encoding'
import { beforeAll, describe, expect, test } from 'vite-plus/test'

import { bodyBytes, bytes, cacheRuntime, narKey, request, seed, text, workerBundle } from './cache-fixture.ts'
import { runTest } from './support.ts'

const challengesBasic = (header: string | null): boolean =>
  Option.exists(Option.fromNullishOr(header), String.includes('Basic'))

// oxlint-disable-next-line eslint/max-lines-per-function, eslint/max-statements -- These HTTP scenarios share one compiled Worker fixture and a single Vitest lifecycle owner.
describe('cache', () => {
  beforeAll(async () => {
    await runTest(workerBundle)
  }, 60_000)

  test('a warm cache still authenticates and never exposes public caching headers', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('BUCKET'))
        yield* Effect.promise(async () => bucket.put('nix-cache-info', 'StoreDir: /nix/store\n'))
        const first = yield* request(runtime, 'nix-cache-info')
        expect({ body: yield* text(first), status: first.status }).toStrictEqual({
          body: 'StoreDir: /nix/store\n',
          status: 200,
        })
        // Removing the origin object proves the second response comes from the real Cache API.
        yield* Effect.promise(async () => bucket.delete('nix-cache-info'))
        const cached = yield* request(runtime, 'nix-cache-info')
        expect({
          body: yield* text(cached),
          policy: cached.headers.get('cache-control'),
          status: cached.status,
          vary: cached.headers.get('vary'),
        }).toStrictEqual({
          body: 'StoreDir: /nix/store\n',
          policy: 'private, no-store',
          status: 200,
          vary: 'Authorization',
        })
        const denied = yield* request(runtime, 'nix-cache-info', { headers: { authorization: '' } })
        expect({
          challengesBasic: challengesBasic(denied.headers.get('www-authenticate')),
          status: denied.status,
        }).toStrictEqual({ challengesBasic: true, status: 401 })
      }),
    )
  })

  test.each(['', 'Basic bad', `Basic ${Base64.encode('reader:incorrect')}`])(
    'rejects invalid reader credentials: %s',
    async (invalid) => {
      expect.hasAssertions()
      return runTest(
        Effect.gen(function* () {
          const runtime = yield* cacheRuntime()
          const response = yield* request(runtime, narKey, { headers: { authorization: invalid } })
          expect(response.status).toBe(401)
          expect(response.headers.get('cache-control')).toBe('private, no-store')
        }),
      )
    },
  )

  test('streams a complete binary NAR without converting its payload to text', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        yield* seed(runtime)
        const response = yield* request(runtime, narKey)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-length')).toBe('8')
        expect(yield* bodyBytes(response)).toStrictEqual(Array.fromIterable(bytes))
      }),
    )
  })

  test('returns HEAD metadata without a body', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        yield* seed(runtime)
        const response = yield* request(runtime, narKey, { method: 'HEAD' })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-length')).toBe('8')
        expect(yield* text(response)).toBe('')
      }),
    )
  })

  test('lets the Cache API decide whether to store an object above the former size cap', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('BUCKET'))
        const aboveFormerCap = 128 * 1024 * 1024 + 1
        // Native bytes belong to the R2 and response body interoperability boundary.
        yield* Effect.promise(async () => bucket.put(narKey, new Uint8Array(aboveFormerCap)))
        const first = yield* request(runtime, narKey)
        expect({
          size: (yield* Effect.promise(async () => first.arrayBuffer())).byteLength,
          status: first.status,
        }).toStrictEqual({ size: aboveFormerCap, status: 200 })
        yield* Effect.promise(async () => bucket.delete(narKey))
        const cached = yield* request(runtime, narKey)
        expect({
          policy: cached.headers.get('cache-control'),
          size: (yield* Effect.promise(async () => cached.arrayBuffer())).byteLength,
          status: cached.status,
        }).toStrictEqual({ policy: 'private, no-store', size: aboveFormerCap, status: 200 })
      }),
    )
  })

  test.each([
    { contentRange: 'bytes 1-3/8', expected: [255, 1, 128], range: 'bytes=1-3' },
    { contentRange: 'bytes 6-7/8', expected: [4, 5], range: 'bytes=-2' },
    { contentRange: 'bytes 6-7/8', expected: [4, 5], range: 'bytes=6-' },
    { contentRange: 'bytes 6-7/8', expected: [4, 5], range: 'bytes=6-99' },
    { contentRange: 'bytes 0-7/8', expected: Array.fromIterable(bytes), range: 'bytes=-99' },
  ])('serves the requested byte range $range', async ({ range, expected, contentRange }) => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        yield* seed(runtime)
        const response = yield* request(runtime, narKey, { headers: { range } })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe(contentRange)
        expect(yield* bodyBytes(response)).toStrictEqual(expected)
      }),
    )
  })

  test.each(['bytes=99-', 'bytes=4-1', 'bytes=-0', 'bytes=1.5-3', 'bytes=1e0-3', 'bytes=0-1,4-5'])(
    'rejects unsupported or unsatisfiable range %s',
    async (range) => {
      expect.hasAssertions()
      return runTest(
        Effect.gen(function* () {
          const runtime = yield* cacheRuntime()
          yield* seed(runtime)
          const response = yield* request(runtime, narKey, { headers: { range } })
          expect(response.status).toBe(416)
          expect(response.headers.get('content-range')).toBe('bytes */8')
        }),
      )
    },
  )

  const validators: {
    name: string
    headers: (metadata: { etag: string; modified: string }) => Record<string, string>
    status: number
  }[] = [
    {
      headers: ({ etag }) => ({ 'if-none-match': etag }),
      name: 'matching If-None-Match',
      status: 304,
    },
    {
      headers: ({ etag }) => ({ 'if-none-match': `W/${etag}` }),
      name: 'weak If-None-Match',
      status: 304,
    },
    {
      headers: ({ modified }) => ({ 'if-modified-since': modified }),
      name: 'matching If-Modified-Since',
      status: 304,
    },
    { headers: () => ({ 'if-match': '"stale"' }), name: 'stale If-Match', status: 412 },
    { headers: ({ etag }) => ({ 'if-match': `W/${etag}` }), name: 'weak If-Match', status: 412 },
    {
      headers: () => ({ 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }),
      name: 'stale If-Unmodified-Since',
      status: 412,
    },
    {
      headers: ({ etag }) => ({
        'if-match': etag,
        'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT',
      }),
      name: 'If-Match takes precedence over If-Unmodified-Since',
      status: 200,
    },
  ]

  test.each(validators)('handles $name', async ({ headers, status }) => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        yield* seed(runtime)
        const head = yield* request(runtime, narKey, { method: 'HEAD' })
        const metadata = {
          etag: Option.getOrThrow(Option.fromNullishOr(head.headers.get('etag'))),
          modified: Option.getOrThrow(Option.fromNullishOr(head.headers.get('last-modified'))),
        }
        const response = yield* request(runtime, narKey, { headers: headers(metadata) })
        expect(response.status).toBe(status)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
      }),
    )
  })

  test('a stale If-Range returns the complete representation', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        yield* seed(runtime)
        const response = yield* request(runtime, narKey, {
          headers: { 'if-range': '"stale"', range: 'bytes=1-3' },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-range')).toBeNull()
        expect(yield* bodyBytes(response)).toStrictEqual(Array.fromIterable(bytes))
      }),
    )
  })

  test('rechecks If-Range when R2 changes between HEAD and GET', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('BUCKET'))
        const original = yield* Effect.promise(async () => bucket.put(narKey, 'original-content'))
        const response = yield* request(runtime, narKey, {
          headers: {
            'if-range': original.httpEtag,
            range: 'bytes=0-3',
            'x-test-replace-after-head': '1',
          },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-range')).toBeNull()
        expect(yield* text(response)).toBe('replacement-content')
      }),
    )
  })

  test.each([
    'cache-v2.narinfo',
    'nar/nonstandard-digest.nar.future',
    'release@2026.narinfo',
    'nar/release+debug.nar.future',
    'nar/%2fsecret.nar',
  ])('treats cache object names as opaque within the allowed namespace: %s', async (key) => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('BUCKET'))
        yield* Effect.promise(async () => bucket.put(key, 'opaque cache content'))
        const response = yield* request(runtime, key)
        expect(response.status).toBe(200)
        expect(yield* text(response)).toBe('opaque cache content')
      }),
    )
  })
})
