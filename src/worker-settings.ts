export const stackName = 'nix-cache'
export const productionStage = 'production'
export const workerId = 'nix-cache-reader'
export const bucketId = 'nix-cache-objects'

export const workerProps = {
  // Set the pinned Alchemy compatibility defaults explicitly so both source builds receive the same flags.
  compatibility: { date: '2026-09-25', flags: ['nodejs_compat', 'new_module_registry'] },
  source: {
    devMode: 'bundle' as const,
    options: { main: new URL('entry.workers.ts', import.meta.url).href },
    provider: new URL('worker-source.ts', import.meta.url).href,
  },
}
