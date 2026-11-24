import { resolveSource, SourceProviderError } from 'alchemy/Cloudflare/Workers'
import type { WorkerSourceModule } from 'alchemy/Cloudflare/Workers'
import { Effect, Schema } from 'effect'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Alchemy supplies descriptor options as unknown.
const decodeOptions = Schema.decodeUnknownEffect(Schema.Struct({ main: Schema.String }))

const source: WorkerSourceModule = {
  make: (options) =>
    decodeOptions(options).pipe(
      Effect.mapError(
        (cause) =>
          new SourceProviderError({
            cause,
            message: 'The Worker source requires a main module',
            provider: import.meta.url,
          }),
      ),
      Effect.flatMap(({ main }) => resolveSource({ main })),
    ),
}

// oxlint-disable-next-line import/no-default-export -- Alchemy reads the Worker source provider from the module default.
export default source
