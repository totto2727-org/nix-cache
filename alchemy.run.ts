import { localState, Stack } from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Effect } from 'effect'

import workerLayer, { Worker } from './src/entry.workers.ts'

// oxlint-disable-next-line import/no-default-export -- The Alchemy CLI loads the Stack as the configuration module default.
export default Stack(
  'nix-cache',
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const worker = yield* Worker.pipe(Effect.provide(workerLayer))
    return { url: worker.url }
  }),
)
