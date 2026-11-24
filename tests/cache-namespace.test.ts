import { Effect, String } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { cacheRuntime, getBucket, infoKey, request } from './cache-fixture.ts'
import { runTest } from './support.ts'

describe('cache object namespace', () => {
  test.each([`${infoKey}?bust=1`, 'other-secret-file', 'nar/nested/file.nar', 'nar/', 'other/file.nar'])(
    'rejects paths outside the binary cache namespace: %s',
    async (key) => {
      expect.hasAssertions()
      return runTest(
        Effect.gen(function* () {
          const runtime = yield* cacheRuntime()
          const bucket = yield* getBucket(runtime)
          const [storedKey] = String.split(key, '?')
          yield* Effect.promise(async () => bucket.put(storedKey, 'outside the allowed namespace'))
          expect((yield* request(runtime, key)).status).toBe(404)
        }),
      )
    },
  )
})
