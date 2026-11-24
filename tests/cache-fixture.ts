// oxlint-disable-next-line rules/no-node-imports -- Node erases types from the test-only Workerd fault adapter without invoking any bundler.
import { stripTypeScriptTypes } from 'node:module'

import type { PlatformError, Scope } from 'effect'
import { Array, Effect, FileSystem, Path, Record, Schema, String } from 'effect'
import { Base64 } from 'effect/encoding'
import type { Miniflare } from 'miniflare'

// oxlint-disable-next-line import/no-relative-parent-imports -- Workerd must run the manifest emitted by the production source provider.
import { WorkerArtifact, workerArtifactDirectory } from '../src/worker-artifact.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- Miniflare binds the same R2 resource name and compatibility settings as the deployed Worker.
import { bucketId, workerProps } from '../src/worker-settings.ts'
import { miniflare, runTest } from './support.ts'

const authorization = `Basic ${Base64.encode('reader:test-secret')}`
const narHashWidth = 52
const storePathHashWidth = 32
// oxlint-disable-next-line eslint/no-magic-numbers -- The binary fixture deliberately includes zero, high-bit bytes, and 0xff.
const testBytes = [0, 255, 1, 128, 2, 3, 4, 5]
export const narKey = `nar/${String.repeat(narHashWidth)('0')}.nar.zst`
export const infoKey = `${String.repeat(storePathHashWidth)('0')}.narinfo`
export const bytes = new Uint8Array(testBytes)

const decodeManifest = Schema.decodeEffect(WorkerArtifact)
const faultHost = 'worker-faults.mjs'

const readArtifact = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve(workerArtifactDirectory)
  const metadata = yield* fs.readFileString(path.join(directory, 'manifest.json'))
  const manifest = yield* decodeManifest(metadata)
  const modulesRoot = path.join(directory, manifest.hash)
  const files = Array.filter(manifest.modules, String.endsWith('.js'))
  const modules = yield* Effect.forEach(files, (name) =>
    fs
      .readFileString(path.join(modulesRoot, name))
      .pipe(Effect.map((contents) => [name, { contents, type: 'esm' as const }] as const)),
  )
  return { mainModule: manifest.entry, modules: Record.fromEntries(modules) }
})

export const workerBundle = await runTest(Effect.cached(readArtifact))

export type Fault = 'r2-error' | 'cache-match' | 'cache-put' | 'replace-once' | 'replace-always'

const localBindings = {
  ALCHEMY_CLOUDFLARE_ACCOUNT_ID: { type: 'text' as const, value: 'local-test-account' },
  NIX_CACHE_PASSWORD: { type: 'text' as const, value: 'test-secret' },
  NIX_CACHE_USERNAME: { type: 'text' as const, value: 'reader' },
  [bucketId]: {
    dev: {
      experimentalS3Credentials: {
        accessKeyId: 'local-test-access-key',
        secretAccessKey: 'local-test-secret-key',
      },
    },
    name: 'test-cache',
    type: 'r2' as const,
  },
}

const faultConfiguration = (
  entry: string,
  fault: Fault,
): Effect.Effect<
  { bindings: Record<string, { type: 'text'; value: string }>; module: { contents: string; type: 'esm' } },
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString('tests/worker-faults.ts')
    const contents = stripTypeScriptTypes(source)
    return {
      bindings: {
        TEST_BUCKET_BINDING: { type: 'text', value: bucketId },
        TEST_FAULT: { type: 'text', value: fault },
        TEST_WORKER_MODULE: { type: 'text', value: `./${entry}` },
      },
      module: { contents, type: 'esm' },
    }
  })

export const cacheRuntime = (
  fault?: Fault,
): Effect.Effect<
  Miniflare,
  PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const artifact = yield* workerBundle
    const fixture = fault ? yield* faultConfiguration(artifact.mainModule, fault) : undefined
    const manifest = fixture
      ? { mainModule: faultHost, modules: { ...artifact.modules, [faultHost]: fixture.module } }
      : artifact
    const { date, flags } = workerProps.compatibility
    return yield* miniflare({
      workers: [
        {
          config: {
            compatibilityDate: date,
            compatibilityFlags: flags,
            env: { ...localBindings, ...fixture?.bindings },
            manifest,
            name: 'nix-cache-test',
          },
        },
      ],
    })
  })

export const getBucket = (runtime: Miniflare): Effect.Effect<Awaited<ReturnType<Miniflare['getR2Bucket']>>> =>
  Effect.promise(async () => runtime.getR2Bucket(bucketId))

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
    const bucket = yield* getBucket(runtime)
    yield* Effect.promise(async () => bucket.put(narKey, bytes))
    return bucket
  })
