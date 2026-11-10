import cloudflare from '@alchemy.run/cloudflare-runtime/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import { purePlugin } from 'alchemy/Bundle/PurePlugin'
import { Array, String } from 'effect'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

const entry = 'virtual:nix-cache/worker'
const resolvedEntry = `\0${entry}`

export default defineConfig({
  plugins: [
    purePlugin(),
    // Alchemy injects its own host, and Vitest tests own their Miniflare runtime.
    process.env['ALCHEMY_CLOUDFLARE_VITE_INJECTED'] === '1' || process.env['VITEST']
      ? null
      : cloudflare({ compatibilityDate: '2026-09-25', compatibilityFlags: ['nodejs_compat'] }),
    {
      name: 'nix-cache:alchemy-worker',
      config: () => ({
        define: { 'globalThis.__ALCHEMY_RUNTIME__': 'true' },
        resolve: { dedupe: ['effect'] },
      }),
      resolveId: (id) => (id === entry ? resolvedEntry : undefined),
      load: (id) => {
        if (id !== resolvedEntry) return
        return Array.join(
          [
            'import { env, WorkerEntrypoint } from "cloudflare:workers";',
            'import { makeWorkerBridge } from "alchemy/Cloudflare/Bridge";',
            'import entrypoint from "/src/entry.workers.ts";',
            'const stack = { name: env.ALCHEMY_STACK_NAME, stage: env.ALCHEMY_STAGE };',
            'if (!stack.name || !stack.stage) throw new Error("Start the Worker with alchemy dev.");',
            'export default makeWorkerBridge(WorkerEntrypoint, { entrypoint, stack });',
          ],
          '\n',
        )
      },
    },
  ],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'esnext',
    rolldownOptions: {
      input: { index: entry },
      external: (id) => String.startsWith('cloudflare:')(id),
    },
  },
  fmt: {
    ignorePatterns,
    arrowParens: 'always',
    experimentalSortImports: {
      ignoreCase: true,
      newlinesBetween: true,
      order: 'asc',
    },
    experimentalSortPackageJson: true,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    ignorePatterns,
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
  run: {
    tasks: {
      dev: { command: 'alchemy dev --config alchemy.run.ts --no-input', cache: false },
      build: { command: 'vp build', cache: false },
      check: { command: 'vp check', cache: false },
      fix: { command: 'vp check --fix', cache: false },
      test: { command: 'vp test run', dependsOn: ['build'], cache: false },
      ci: { command: '', dependsOn: ['check', 'test'], cache: false },
    },
  },
})
