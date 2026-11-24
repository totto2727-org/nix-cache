import { NodeServices } from '@effect/platform-node'
import { provideFreshArtifactStore, scopedArtifacts } from 'alchemy/Artifacts'
import type { BundleOutput } from 'alchemy/Bundle'
import { makeSourceContext, resolveSource } from 'alchemy/Cloudflare/Workers'
import type { PlatformError, Scope } from 'effect'
import { Array, Data, Effect, FileSystem, Path, Predicate, Schema } from 'effect'

// oxlint-disable-next-line import/no-relative-parent-imports -- The offline command owns the manifest read by Workerd acceptance tests.
import { WorkerArtifact, workerArtifactDirectory } from '../src/worker-artifact.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- The build task must pass the deployed Worker's exact props to the Alchemy source provider.
import { productionStage, stackName, workerId, workerProps } from '../src/worker-settings.ts'

class MissingWorkerBundle extends Data.TaggedError('MissingWorkerBundle')<{ message: string }> {}

const encode = Schema.encodeEffect(WorkerArtifact)

const buildWorker = Effect.gen(function* () {
  const source = yield* resolveSource(workerProps)
  const output = yield* source.build(
    makeSourceContext({
      compatibility: workerProps.compatibility,
      fqn: workerId,
      id: workerId,
      props: workerProps,
      stack: { name: stackName, stage: productionStage },
      workerName: workerId,
    }),
  )
  if (Predicate.isNullish(output.bundle)) {
    return yield* new MissingWorkerBundle({ message: 'Alchemy did not return the Worker bundle' })
  }
  return output.bundle
})

const publishManifest = (
  directory: string,
  bundle: BundleOutput,
): Effect.Effect<
  void,
  PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const modules = Array.map(bundle.files, (file) => file.path)
    const manifest = yield* encode({ entry: bundle.files[0].path, hash: bundle.hash, modules })
    const pending = yield* fs.makeTempFileScoped({ directory, prefix: 'manifest-' })
    yield* fs.writeFileString(pending, manifest)
    yield* fs.rename(pending, path.join(directory, 'manifest.json'))
  })

const writeArtifact = Effect.gen(function* () {
  const bundle = yield* buildWorker
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve(workerArtifactDirectory)
  const modulesRoot = path.join(directory, bundle.hash)
  yield* fs.makeDirectory(modulesRoot, { recursive: true })
  yield* Effect.forEach(
    bundle.files,
    (file) => {
      const destination = path.join(modulesRoot, file.path)
      const parent = path.dirname(destination)
      const { content } = file
      const write = Predicate.isString(content)
        ? fs.writeFileString(destination, content)
        : fs.writeFile(destination, content)
      return fs.makeDirectory(parent, { recursive: true }).pipe(Effect.andThen(write))
    },
    { discard: true },
  )
  yield* publishManifest(directory, bundle)
  yield* Effect.logInfo(`Alchemy Worker bundle: ${bundle.hash}`)
})

const nodeBuild = writeArtifact.pipe(
  Effect.provide(scopedArtifacts(workerId)),
  provideFreshArtifactStore,
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

// oxlint-disable-next-line rules/no-effect-runtime-run -- This CLI runs the offline Alchemy source build and writes its artifact manifest.
await Effect.runPromise(nodeBuild)
