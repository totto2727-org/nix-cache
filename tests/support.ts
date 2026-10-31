import * as NodeServices from "@effect/platform-node/NodeServices";
import { Array, Effect, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare } from "miniflare";

export const runTest = <A, E>(
  program: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
) => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

// Miniflare exposes Promise-based runtime lifecycle and Cloudflare bindings.
export const miniflare = (options: ConstructorParameters<typeof Miniflare>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => new Miniflare(options)),
    (runtime) => Effect.promise(() => runtime.dispose()),
  ).pipe(Effect.tap((runtime) => Effect.promise(() => runtime.ready)));

export const command = (
  name: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(name, args, options));
      const [stdoutChunks, stderr, exitCode] = yield* Effect.all(
        [
          Stream.runCollect(handle.stdout),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const stdout = yield* Stream.mkString(Stream.decodeText(Stream.fromArray(stdoutChunks)));
      return {
        stdout,
        stdoutBytes: Array.flatMap(stdoutChunks, Array.fromIterable),
        stderr,
        exitCode,
      };
    }),
  );
