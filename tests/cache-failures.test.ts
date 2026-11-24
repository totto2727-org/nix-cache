import { Array, Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'

import {
  bodyBytes,
  bytes,
  cacheRuntime,
  getBucket,
  infoKey,
  narKey,
  request,
  seed,
  text,
  workerBundle,
} from './cache-fixture.ts'
import { runTest } from './support.ts'

// oxlint-disable-next-line eslint/max-lines-per-function -- These scenarios share the workerd fault-injection fixture and runtime setup.
describe('cache failure responses', () => {
  beforeAll(async () => {
    await runTest(workerBundle)
  }, 60_000)

  test.each(['GET', 'HEAD'])('returns a private generic 502 when R2 %s fails', async (method) => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime('r2-error')
        yield* seed(runtime)
        const response = yield* request(runtime, narKey, {
          method,
        })
        expect(response.status).toBe(502)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(yield* text(response)).toBe('')
      }),
    )
  })

  test.each(['cache-match', 'cache-put'] as const)(
    'serves the original bytes when the Cache API fails: %s',
    async (fault) => {
      expect.hasAssertions()
      return runTest(
        Effect.gen(function* () {
          const runtime = yield* cacheRuntime(fault)
          yield* seed(runtime)
          const response = yield* request(runtime, narKey)
          expect(response.status).toBe(200)
          expect(response.headers.get('cache-control')).toBe('private, no-store')
          expect(response.headers.get('content-length')).toBe('8')
          expect(yield* bodyBytes(response)).toStrictEqual(Array.fromIterable(bytes))
        }),
      )
    },
  )

  test('fails closed after a bounded retry when R2 keeps changing', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime('replace-always')
        yield* seed(runtime)
        const response = yield* request(runtime, narKey, {
          headers: { range: 'bytes=0-3' },
        })
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(yield* text(response)).toBe('')
      }),
    )
  })

  test('does not cache a missing narinfo', async () => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        expect((yield* request(runtime, infoKey)).status).toBe(404)
        const bucket = yield* getBucket(runtime)
        yield* Effect.promise(async () => bucket.put(infoKey, 'StorePath: /nix/store/example\n'))
        const available = yield* request(runtime, infoKey)
        expect(available.status).toBe(200)
        expect(yield* text(available)).toBe('StorePath: /nix/store/example\n')
      }),
    )
  })

  test.each(['PUT', 'POST', 'DELETE', 'OPTIONS'])('rejects reader method %s', async (method) => {
    expect.hasAssertions()
    return runTest(
      Effect.gen(function* () {
        const runtime = yield* cacheRuntime()
        const response = yield* request(runtime, infoKey, { method })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET, HEAD')
      }),
    )
  })
})
