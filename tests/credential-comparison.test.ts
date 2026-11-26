import { BrowserCrypto } from '@effect/platform-browser'
import { Cause, Effect, PlatformError } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the same credential adapter used by the Worker.
import { credentialsMatch } from '../src/cloudflare-storage.ts'
import { failedCryptoLayer } from './crypto-fixture.ts'
import { runTest } from './support.ts'

const digest = crypto.subtle.digest.bind(crypto.subtle)

const withNativeComparator = (timingSafeEqual?: (left: Uint8Array, right: Uint8Array) => boolean): Crypto => ({
  getRandomValues: (value) => crypto.getRandomValues(value),
  randomUUID: () => crypto.randomUUID(),
  subtle: new Proxy(crypto.subtle, {
    get: (subtle, key): unknown => (key === 'timingSafeEqual' ? timingSafeEqual : Reflect.get(subtle, key, subtle)),
  }),
})

describe('credential comparison', () => {
  test.each([
    { expected: 'secret', matches: true, supplied: 'secret' },
    { expected: 'secret', matches: false, supplied: 'secreu' },
    { expected: 'secret', matches: false, supplied: 'short' },
    { expected: '秘密🔑', matches: true, supplied: '秘密🔑' },
  ])(
    'passes the UTF-8 digests to the native comparison boundary: $supplied',
    async ({ expected, matches, supplied }) => {
      expect.hasAssertions()
      // NodeServices supplies the digest. Provide the Workers comparator through BrowserCrypto.
      const timingSafeEqual = vi.fn<(left: Uint8Array, right: Uint8Array) => boolean>().mockReturnValue(matches)
      const program = credentialsMatch(supplied, expected).pipe(
        Effect.provideService(BrowserCrypto.WebCrypto, withNativeComparator(timingSafeEqual)),
      )
      await expect(runTest(program)).resolves.toBe(matches)
      const encoder = new TextEncoder()
      const suppliedDigest = await digest('SHA-256', encoder.encode(supplied))
      const expectedDigest = await digest('SHA-256', encoder.encode(expected))
      expect(timingSafeEqual).toHaveBeenCalledExactlyOnceWith(
        new Uint8Array(suppliedDigest),
        new Uint8Array(expectedDigest),
      )
    },
  )

  test('fails when the Crypto service digest fails and skips comparison', async () => {
    expect.hasAssertions()
    const timingSafeEqual = vi.fn<() => boolean>()
    const program = credentialsMatch('secret', 'secret').pipe(
      Effect.provide(failedCryptoLayer),
      Effect.provideService(BrowserCrypto.WebCrypto, withNativeComparator(timingSafeEqual)),
    )
    await expect(runTest(program)).rejects.toBeInstanceOf(PlatformError.PlatformError)
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })

  test('fails when the native comparison extension is unavailable', async () => {
    expect.hasAssertions()
    const program = credentialsMatch('secret', 'secret').pipe(
      Effect.provideService(BrowserCrypto.WebCrypto, withNativeComparator()),
    )
    await expect(runTest(program)).rejects.toBeInstanceOf(Cause.UnknownError)
  })
})
