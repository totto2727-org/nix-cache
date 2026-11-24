// oxlint-disable-next-line rules/no-node-imports -- The compiler plugin must load in Node outside Vitest's runtime module transform.
import { createRequire } from 'node:module'

import type * as PurePlugin from 'alchemy/Bundle/PurePlugin'
import { Array, Data, Effect, Option, Path, Record, String } from 'effect'
import type { Scope } from 'effect'
import { Base64 } from 'effect/encoding'
import type { Miniflare } from 'miniflare'
import { build } from 'vite'

import { miniflare, runTest } from './support.ts'

const authorization = `Basic ${Base64.encode('reader:test-secret')}`
const narHashWidth = 52
const storePathHashWidth = 32
// oxlint-disable-next-line eslint/no-magic-numbers -- The binary fixture deliberately includes zero, high-bit bytes, and 0xff.
const testBytes = [0, 255, 1, 128, 2, 3, 4, 5]
export const narKey = `nar/${String.repeat(narHashWidth)('0')}.nar.zst`
export const infoKey = `${String.repeat(storePathHashWidth)('0')}.narinfo`
export const bytes = new Uint8Array(testBytes)

class WorkerBundleError extends Data.TaggedError('WorkerBundleError')<{ message: string }> {}

// oxlint-disable-next-line eslint/max-statements -- Compile the acceptance Worker and validate both the output and its entry chunk before handing it to workerd.
const compileWorker = Effect.gen(function* () {
  const path = yield* Path.Path
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Use Node's synchronous module loader for this fixed compiler plugin, outside Vitest's module transform.
  const { purePlugin } = createRequire(import.meta.url)('alchemy/Bundle/PurePlugin') as typeof PurePlugin
  const result = yield* Effect.promise(async () =>
    build({
      build: {
        minify: false,
        rolldownOptions: { preserveEntrySignatures: 'strict' },
        ssr: path.resolve('tests/workerd-entry.ts'),
        write: false,
      },
      configFile: false,
      define: { 'globalThis.__ALCHEMY_RUNTIME__': 'true' },
      logLevel: 'error',
      plugins: [purePlugin()],
      ssr: { noExternal: true },
    }),
  )
  const built = Array.isArray(result) ? result[0] : result
  if (!built || !('output' in built)) {
    return yield* new WorkerBundleError({ message: 'Expected a completed Worker build' })
  }
  const chunks = Array.filter(built.output, (entry) => entry.type === 'chunk')
  const entry = Array.findFirst(chunks, (chunk) => chunk.isEntry)
  if (Option.isNone(entry)) {
    return yield* new WorkerBundleError({ message: 'Missing acceptance Worker bundle' })
  }
  const modules = Record.fromEntries(
    Array.map(chunks, (chunk) => [chunk.fileName, { contents: chunk.code, type: 'esm' as const }] as const),
  )
  return { mainModule: entry.value.fileName, modules }
})

export const workerBundle = await runTest(Effect.cached(compileWorker))

// The failure module affects only this test isolate. It wraps the same bundled routes.
const withRejectedDigest = (manifest: Effect.Success<typeof workerBundle>): Effect.Success<typeof workerBundle> => {
  const mainModule = 'reject-digest.mjs'
  return {
    mainModule,
    modules: {
      ...manifest.modules,
      [mainModule]: {
        contents: `
          Object.defineProperty(crypto.subtle, 'digest', {
            value: async () => { throw new DOMException('Injected digest failure'); },
          });
          export { default } from './${manifest.mainModule}';
        `,
        type: 'esm',
      },
    },
  }
}

export const cacheRuntime = ({ rejectDigest = false }: { rejectDigest?: boolean } = {}): Effect.Effect<
  Miniflare,
  WorkerBundleError,
  Scope.Scope | Path.Path
> =>
  Effect.flatMap(workerBundle, (manifest) =>
    miniflare({
      workers: [
        {
          config: {
            compatibilityDate: '2026-09-25',
            compatibilityFlags: ['nodejs_compat'],
            env: {
              BUCKET: {
                dev: {
                  experimentalS3Credentials: {
                    accessKeyId: 'local-test-access-key',
                    secretAccessKey: 'local-test-secret-key',
                  },
                },
                name: 'test-cache',
                type: 'r2',
              },
            },
            manifest: rejectDigest ? withRejectedDigest(manifest) : manifest,
            name: 'nix-cache-test',
          },
        },
      ],
    }),
  )

type NativeResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>
export const request = (
  runtime: Miniflare,
  path: string,
  init: {
    method?: string
    body?: string
    headers?: Record<string, string>
  } = {},
): Effect.Effect<NativeResponse> =>
  Effect.promise(async () =>
    runtime.dispatchFetch(`https://cache.example.com/${path}`, {
      ...init,
      headers: { authorization, ...init.headers },
    }),
  )
export const text = (response: NativeResponse): Effect.Effect<string> => Effect.promise(async () => response.text())
// Uint8Array conversion is confined to the native response body's binary boundary.
export const bodyBytes = (response: NativeResponse): Effect.Effect<number[]> =>
  Effect.map(
    Effect.promise(async () => response.arrayBuffer()),
    (buffer) => Array.fromIterable(new Uint8Array(buffer)),
  )
export const seed = (runtime: Miniflare): Effect.Effect<Awaited<ReturnType<Miniflare['getR2Bucket']>>> =>
  Effect.gen(function* () {
    const bucket = yield* Effect.promise(async () => runtime.getR2Bucket('BUCKET'))
    yield* Effect.promise(async () => bucket.put(narKey, bytes))
    return bucket
  })
