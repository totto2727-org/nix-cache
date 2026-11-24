import type { CacheStorage, R2Bucket, R2GetOptions, R2Object, R2ObjectBody } from '@cloudflare/workers-types'
import { withEnv } from 'cloudflare:workers'

import type { Fault } from './cache-fixture.ts'

type ReadBucket = Pick<R2Bucket, 'head'> & {
  get: (name: string, options?: R2GetOptions) => Promise<R2Object | R2ObjectBody | null>
}
interface Bindings {
  TEST_BUCKET_BINDING: string
  TEST_FAULT: Fault
  TEST_WORKER_MODULE: string
}
interface ArtifactWorker {
  fetch: (request: Request) => Promise<Response>
}
interface WorkerModule {
  default: new (context: unknown, env: Bindings) => ArtifactWorker
}

// oxlint-disable-next-line typescript/require-await -- Native Worker I/O reports injected failures through rejected promises.
const reject = async (message: string): Promise<never> => {
  throw new DOMException(message)
}

const instrumentBucket = (bucket: R2Bucket, fault: Fault): ReadBucket => {
  const noReplacements = 0
  const replacements = { count: noReplacements }
  return {
    get: async (name, options) => {
      if (fault === 'r2-error') {
        return reject('Injected R2 read failure')
      }
      return bucket.get(name, options)
    },
    head: async (name) => {
      if (fault === 'r2-error') {
        return reject('Injected R2 metadata failure')
      }
      const result = await bucket.head(name)
      const firstRead = replacements.count === noReplacements
      if (fault === 'replace-always' || (fault === 'replace-once' && firstRead)) {
        replacements.count += 1
        const content = fault === 'replace-always' ? `replacement-content-${replacements.count}` : 'replacement-content'
        await bucket.put(name, content)
      }
      return result
    },
  }
}

const injectCache = (fault: Fault): (() => void) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Workerd's CacheStorage adds a default binding to the DOM API.
  const { default: cache } = globalThis.caches as unknown as CacheStorage
  const current = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  const match =
    fault === 'cache-match'
      ? async (): Promise<never> => reject('Injected cache lookup failure')
      : cache.match.bind(cache)
  const put =
    fault === 'cache-put' ? async (): Promise<never> => reject('Injected cache write failure') : cache.put.bind(cache)
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: { match, put } } })
  return () => {
    if (current) {
      Object.defineProperty(globalThis, 'caches', current)
    } else {
      Reflect.deleteProperty(globalThis, 'caches')
    }
  }
}

// BrowserCrypto translates this native rejection into an Effect PlatformError.
const injectDigestFailure = (): (() => void) => {
  const { subtle } = crypto
  const original = Object.getOwnPropertyDescriptor(subtle, 'digest')
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    value: async (): Promise<never> => reject('Injected Web Crypto digest failure'),
  })
  return () => {
    if (original) {
      Object.defineProperty(subtle, 'digest', original)
    } else {
      Reflect.deleteProperty(subtle, 'digest')
    }
  }
}

const dispatch = async (request: Request, env: Bindings, context: unknown): Promise<Response> => {
  const { TEST_BUCKET_BINDING: name, TEST_FAULT: fault, TEST_WORKER_MODULE: module } = env
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The manifest names the official Alchemy Worker bridge class.
  const { default: Worker } = (await import(module)) as WorkerModule
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare creates the binding under this configured name as native R2.
  const bucket = (env as unknown as Record<string, unknown>)[name] as R2Bucket
  const bindings = { ...env, [name]: instrumentBucket(bucket, fault) }
  const worker = new Worker(context, bindings)
  const response = await withEnv(bindings, async () => worker.fetch(request))
  if (!(response instanceof Response)) {
    throw new DOMException('The Alchemy Worker did not return a response')
  }
  return response
}

const injectFault = (fault: Fault): (() => void) | undefined => {
  if (fault === 'crypto-digest') {
    return injectDigestFailure()
  }
  return fault === 'cache-match' || fault === 'cache-put' ? injectCache(fault) : undefined
}

const host = {
  async fetch(request: Request, env: Bindings, context: unknown): Promise<Response> {
    const restore = injectFault(env.TEST_FAULT)
    try {
      return await dispatch(request, env, context)
    } finally {
      restore?.()
    }
  },
}

// oxlint-disable-next-line import/no-default-export -- Workerd reads the fault-injection host from the default export.
export default host
