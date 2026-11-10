import { localState, Stack, Stage } from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Effect, Layer } from 'effect'

import workerLayer, { Worker } from './src/entry.workers'

export default Stack(
  'nix-cache',
  {
    state: Layer.unwrap(
      Stage.pipe(Effect.map((stage) => (stage === 'production' ? Cloudflare.state() : localState()))),
    ),
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker.pipe(Effect.provide(workerLayer))
    return { url: worker.url }
  }),
)
