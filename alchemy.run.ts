import { localState, Stack, Stage } from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Effect, Layer } from 'effect'

import workerLayer, { Worker } from './src/entry.workers.ts'

const state = Layer.unwrap(
  Stage.pipe(Effect.map((stage) => (stage === 'production' ? Cloudflare.state() : localState()))),
)

// oxlint-disable-next-line import/no-default-export -- The Alchemy CLI loads the Stack as the configuration module default.
export default Stack(
  'nix-cache',
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* Worker.pipe(Effect.provide(workerLayer))
    return { url: worker.url }
  }),
)
