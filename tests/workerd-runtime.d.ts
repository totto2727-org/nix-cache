// The Worker-only API is provided by workerd, outside the Node test host.
declare module 'cloudflare:workers' {
  export function withEnv(environment: unknown, run: () => unknown): unknown
}
