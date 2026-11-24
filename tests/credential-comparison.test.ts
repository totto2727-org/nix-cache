import { Cause } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the same credential adapter used by the Worker.
import { credentialsMatch } from '../src/cloudflare-storage.ts'
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
      // Node provides digest. The comparator mock exposes the workerd call and its inputs.
      const timingSafeEqual = vi.fn<(left: ArrayBuffer, right: ArrayBuffer) => boolean>().mockReturnValue(matches)
      vi.stubGlobal('crypto', { subtle: { digest, timingSafeEqual } })
      await expect(runTest(credentialsMatch(supplied, expected))).resolves.toBe(matches)
      const encoder = new TextEncoder()
      expect(timingSafeEqual).toHaveBeenCalledExactlyOnceWith(
        await digest('SHA-256', encoder.encode(supplied)),
        await digest('SHA-256', encoder.encode(expected)),
      )
    },
  )

  test('fails when digest rejects and skips comparison', async () => {
    expect.hasAssertions()
    const timingSafeEqual = vi.fn<() => boolean>()
    const failedDigest = vi.fn<typeof digest>().mockRejectedValue(new DOMException('Injected digest failure'))
    vi.stubGlobal('crypto', { subtle: { digest: failedDigest, timingSafeEqual } })
    await expect(runTest(credentialsMatch('secret', 'secret'))).rejects.toBeInstanceOf(Cause.UnknownError)
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })

  test('fails when the native comparison extension is unavailable', async () => {
    expect.hasAssertions()
    vi.stubGlobal('crypto', { subtle: { digest } })
    await expect(runTest(credentialsMatch('secret', 'secret'))).rejects.toBeInstanceOf(Cause.UnknownError)
  })
})
