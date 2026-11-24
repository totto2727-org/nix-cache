import type { PlatformError } from 'effect'
import { Config, Data, Effect, FileSystem, Path, Schema } from 'effect'
import type { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, test } from 'vite-plus/test'

import { cacheRuntime } from './cache-fixture.ts'
import { command, runTest } from './support.ts'

class NixCommandFailed extends Data.TaggedError('NixCommandFailed')<{ exitCode: number; stderr: string }> {}

// oxlint-disable-next-line eslint/max-lines-per-function, eslint/max-statements -- The real Nix round trip checks upload and pull credentials against one ephemeral S3 store and compares the resulting bytes.
const nixRoundTrip = Effect.gen(function* () {
  const runtime = yield* cacheRuntime()
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory('tmp', { recursive: true })
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.resolve('tmp'),
    prefix: 'nix-roundtrip-',
  })
  const inheritedConfig = yield* Config.String('NIX_CONFIG').pipe(Config.withDefault(''))
  const execute = (args: Readonly<string[]>, options: ChildProcess.CommandOptions = {}): ReturnType<typeof command> =>
    command('nix', args, {
      ...options,
      env: {
        ...options.env,
        NIX_CONFIG: `${inheritedConfig}\nnarinfo-cache-positive-ttl = 0\nnarinfo-cache-negative-ttl = 0\n`,
        XDG_CACHE_HOME: path.join(directory, 'nix-cache'),
      },
      extendEnv: true,
    })
  const nix = (
    args: Readonly<string[]>,
    options?: ChildProcess.CommandOptions,
  ): Effect.Effect<
    Effect.Success<ReturnType<typeof command>>,
    NixCommandFailed | PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner
  > =>
    execute(args, options).pipe(
      Effect.tap((result) =>
        result.exitCode === 0
          ? Effect.void
          : new NixCommandFailed({ exitCode: result.exitCode, stderr: result.stderr }),
      ),
    )
  const encodeContent = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
  const content = yield* encodeContent(`authenticated roundtrip ${directory}\n`)
  const { stdout: storePath } = yield* nix(['eval', '--raw', '--expr', `builtins.toFile "nix-cache-probe" ${content}`])
  const url = yield* Effect.promise(async () => runtime.ready)
  // Nix's store prefix preserves Miniflare's native S3 canonical URL, without a proxy or mock.
  const s3 = `s3://cdn-cgi/local/r2/s3/test-cache?scheme=http&endpoint=${url.host}&region=auto&compression=zstd`
  const credentials = {
    AWS_ACCESS_KEY_ID: 'local-test-access-key',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SECRET_ACCESS_KEY: 'local-test-secret-key',
    AWS_SESSION_TOKEN: '',
  }
  const deniedUpload = yield* execute(['copy', '--to', s3, storePath], {
    env: { ...credentials, AWS_SECRET_ACCESS_KEY: 'incorrect' },
  })
  yield* nix(['copy', '--to', s3, storePath], { env: credentials })
  const netrc = path.join(directory, 'netrc')
  const wrongNetrc = path.join(directory, 'wrong-netrc')
  yield* fs.writeFileString(netrc, `machine ${url.hostname}\nlogin reader\npassword test-secret\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  yield* fs.writeFileString(wrongNetrc, `machine ${url.hostname}\nlogin reader\npassword incorrect\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  const deniedPull = yield* execute([
    'store',
    'dump-path',
    '--store',
    url.href,
    '--option',
    'netrc-file',
    wrongNetrc,
    storePath,
  ])
  const pulled = (yield* path.toFileUrl(path.join(directory, 'pulled'))).href
  yield* nix(['copy', '--from', url.href, '--to', pulled, '--option', 'netrc-file', netrc, storePath])
  const expected = yield* nix(['store', 'dump-path', storePath])
  const actual = yield* nix(['store', 'dump-path', '--store', pulled, storePath])
  return { actual, deniedPull, deniedUpload, expected }
})

describe('real Nix S3 push and authenticated Worker pull', () => {
  test('preserves exact NAR bytes and rejects incorrect upload and download credentials', async () => {
    expect.hasAssertions()
    const { actual, deniedPull, deniedUpload, expected } = await runTest(nixRoundTrip)
    expect(deniedUpload.exitCode).not.toBe(0)
    expect(deniedPull.exitCode).not.toBe(0)
    expect(actual.stdoutBytes).toStrictEqual(expected.stdoutBytes)
  }, 60_000)
})
