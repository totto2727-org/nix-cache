import { Cause, Effect, PlatformError } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the same credential adapter used by the Worker.
import { credentialsMatch } from '../src/cloudflare-storage.ts'
import { failedCryptoLayer } from './crypto-fixture.ts'
import { runTest } from './support.ts'

const digest = crypto.subtle.digest.bind(crypto.subtle)

describe('credential comparison', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test.each([
    { expected: 'secret', matches: true, supplied: 'secret' },
    { expected: 'secret', matches: false, supplied: 'secreu' },
    { expected: 'secret', matches: false, supplied: 'short' },
    { expected: '秘密🔑', matches: true, supplied: '秘密🔑' },
  ])(
    'passes the UTF-8 digests to the native comparison boundary: $supplied',
    async ({ expected, matches, supplied }) => {
      expect.hasAssertions()
      // The NodeServices layer supplies Effect Crypto. Mock only the Workers extension.
      const timingSafeEqual = vi.fn<(left: Uint8Array, right: Uint8Array) => boolean>().mockReturnValue(matches)
      vi.stubGlobal('crypto', { subtle: { timingSafeEqual } })
      await expect(runTest(credentialsMatch(supplied, expected))).resolves.toBe(matches)
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
    vi.stubGlobal('crypto', { subtle: { timingSafeEqual } })
    const program = credentialsMatch('secret', 'secret').pipe(Effect.provide(failedCryptoLayer))
    await expect(runTest(program)).rejects.toBeInstanceOf(PlatformError.PlatformError)
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })

  test('fails when the native comparison extension is unavailable', async () => {
    expect.hasAssertions()
    vi.stubGlobal('crypto', { subtle: {} })
    await expect(runTest(credentialsMatch('secret', 'secret'))).rejects.toBeInstanceOf(Cause.UnknownError)
  })
})
