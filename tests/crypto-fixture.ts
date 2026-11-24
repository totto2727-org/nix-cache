import { BrowserCrypto } from '@effect/platform-browser'
import { Crypto, Effect, Layer, PlatformError } from 'effect'

const digestError = PlatformError.systemError({
  // oxlint-disable-next-line rules/require-tagged-data -- Effect's platform error constructor requires a system error tag.
  _tag: 'Unknown',
  description: 'Injected digest failure',
  method: 'digest',
  module: 'Crypto',
})

const failingCrypto = Layer.effect(
  Crypto.Crypto,
  Effect.map(Crypto.Crypto, (cryptography) => ({
    ...cryptography,
    digest: () => Effect.fail(digestError),
  })),
)

export const failedCryptoLayer: Layer.Layer<Crypto.Crypto> = failingCrypto.pipe(Layer.provide(BrowserCrypto.layer))

export const testCryptoLayer = (failDigest: boolean): Layer.Layer<Crypto.Crypto> =>
  failDigest ? failedCryptoLayer : BrowserCrypto.layer
