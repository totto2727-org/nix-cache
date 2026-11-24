import { NodeServices } from '@effect/platform-node'
import type { PlatformError, Scope } from 'effect'
import { Array, Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import type { MiniflareOptions } from 'miniflare'
import { Miniflare } from 'miniflare'

export const runTest = async <A, E>(
  program: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
): Promise<A> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Each Vitest test owns one scoped Effect runtime and awaits its completion.
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

// Miniflare exposes Promise-based runtime lifecycle and Cloudflare bindings.
export const miniflare = (options: MiniflareOptions): Effect.Effect<Miniflare, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Miniflare(options)),
    (runtime) => Effect.promise(async () => runtime.dispose()),
  ).pipe(Effect.tap((runtime) => Effect.promise(async () => runtime.ready)))

interface CommandResult {
  exitCode: ChildProcessSpawner.ExitCode
  stderr: string
  stdout: string
  stdoutBytes: number[]
}

export const command = (
  name: string,
  args: Readonly<string[]>,
  options: ChildProcess.CommandOptions = {},
): Effect.Effect<CommandResult, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(name, args, options))
      const [stdoutChunks, stderr, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: 'unbounded' },
      )
      const stdout = yield* Stream.mkString(Stream.decodeText(Stream.fromArray(stdoutChunks)))
      return {
        exitCode,
        stderr,
        stdout,
        stdoutBytes: Array.flatMap(stdoutChunks, Array.fromIterable),
      }
    }),
  )
