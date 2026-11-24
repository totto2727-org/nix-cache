import { Array, Effect, FileSystem, Path, Record, String } from 'effect'
import { Base64 } from 'effect/encoding'
import { describe, expect, test } from 'vite-plus/test'

import { miniflare, runTest } from './support.ts'

const username = '読者'
const password = '秘密🔑'
const authorization = `Basic ${Base64.encode(`${username}:${password}`)}`

// oxlint-disable-next-line eslint/max-lines-per-function, eslint/max-statements -- Authentication, cold read, cache fill, and warm read must run against the same compiled workerd instance.
const compiledWorkerScenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve('dist/ssr')
  const files = Array.filter(yield* fs.readDirectory(directory, { recursive: true }), String.endsWith('.js'))
  const modules = Record.fromEntries(
    yield* Effect.forEach(files, (name) =>
      Effect.map(
        fs.readFileString(path.join(directory, name)),
        (contents) => [name, { contents, type: 'esm' as const }] as const,
      ),
    ),
  )
  const runtime = yield* miniflare({
    workers: [
      {
        config: {
          compatibilityDate: '2026-09-25',
          compatibilityFlags: ['nodejs_compat'],
          env: {
            ALCHEMY_STACK_NAME: { type: 'text', value: 'nix-cache' },
            ALCHEMY_STAGE: { type: 'text', value: 'test' },
            NIX_CACHE_PASSWORD: { type: 'text', value: password },
            NIX_CACHE_USERNAME: { type: 'text', value: username },
            'nix-cache-objects': { name: 'built-smoke', type: 'r2' },
          },
          manifest: { mainModule: 'index.js', modules },
          name: 'built-worker',
        },
      },
    ],
  })
  // Dispatch and response objects belong to the real workerd test boundary.
  const unauthorized = yield* Effect.promise(async () => runtime.dispatchFetch('https://cache.test/nix-cache-info'))
  // Identity encoding makes byte-length checks independent of edge compression.
  const authorized = yield* Effect.promise(async () =>
    runtime.dispatchFetch('https://cache.test/nix-cache-info', {
      headers: {
        'accept-encoding': 'identity',
        authorization,
      },
    }),
  )

  const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('nix-cache-objects'))
  const content = 'StoreDir: /nix/store\n'
  yield* Effect.promise(async () => bucket.put('nix-cache-info', content))
  const fetched = yield* Effect.promise(async () =>
    runtime.dispatchFetch('https://cache.test/nix-cache-info', {
      headers: {
        'accept-encoding': 'identity',
        authorization,
      },
    }),
  )
  const fetchedBody = yield* Effect.promise(async () => fetched.text())

  yield* Effect.promise(async () => bucket.delete('nix-cache-info'))
  const warm = yield* Effect.promise(async () =>
    runtime.dispatchFetch('https://cache.test/nix-cache-info', {
      headers: {
        'accept-encoding': 'identity',
        authorization,
      },
    }),
  )
  const warmBody = yield* Effect.promise(async () => warm.text())
  const warmUnauthorized = yield* Effect.promise(async () => runtime.dispatchFetch('https://cache.test/nix-cache-info'))
  return {
    cached: {
      body: warmBody,
      length: warm.headers.get('content-length'),
      policy: warm.headers.get('cache-control'),
      status: warm.status,
    },
    fresh: {
      body: fetchedBody,
      length: fetched.headers.get('content-length'),
      policy: fetched.headers.get('cache-control'),
      status: fetched.status,
    },
    missing: { policy: authorized.headers.get('cache-control'), status: authorized.status },
    unauthorized: unauthorized.status,
    warmUnauthorized: warmUnauthorized.status,
  }
})

describe('compiled worker', () => {
  test('the compiled Alchemy Worker authenticates UTF-8 reader credentials before reading R2', async () => {
    expect.hasAssertions()
    const content = 'StoreDir: /nix/store\n'
    const served = { body: content, length: `${content.length}`, policy: 'private, no-store', status: 200 }
    await expect(runTest(compiledWorkerScenario)).resolves.toStrictEqual({
      cached: served,
      fresh: served,
      missing: { policy: 'private, no-store', status: 404 },
      unauthorized: 401,
      warmUnauthorized: 401,
    })
  })
})
