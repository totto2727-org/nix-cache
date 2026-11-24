import cloudflare from '@alchemy.run/cloudflare-runtime/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import preset from '@totto2727/oxlint/preset/application'
import { purePlugin } from 'alchemy/Bundle/PurePlugin'
import { Array, String } from 'effect'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

const entry = 'virtual:nix-cache/worker'
const resolvedEntry = `\0${entry}`

const workerBridgeSource = Array.join(
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

// oxlint-disable-next-line node/no-process-env -- Alchemy signals an existing Worker plugin through this environment variable.
const injectedByAlchemy = process.env['ALCHEMY_CLOUDFLARE_VITE_INJECTED'] === '1'
// oxlint-disable-next-line node/no-process-env -- Vitest signals that Miniflare will own the Worker runtime.
const testing = String.isNonEmpty(process.env['VITEST'] ?? '')

// oxlint-disable-next-line import/no-default-export -- Vite+ loads the configuration from the module default.
export default defineConfig({
  build: {
    rolldownOptions: {
      external: (id) => String.startsWith('cloudflare:')(id),
      input: { index: entry },
    },
    ssr: true,
    target: 'esnext',
  },
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: {
      ignoreCase: true,
      newlinesBetween: true,
      order: 'asc',
    },
    experimentalSortPackageJson: true,
    ignorePatterns,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    env: { node: true },
    extends: [preset],
    ignorePatterns,
    options: { typeAware: true, typeCheck: true },
  },
  plugins: [
    purePlugin(),
    injectedByAlchemy || testing
      ? undefined
      : cloudflare({ compatibilityDate: '2026-09-25', compatibilityFlags: ['nodejs_compat'] }),
    {
      config: () => ({
        define: { 'globalThis.__ALCHEMY_RUNTIME__': 'true' },
        resolve: { dedupe: ['effect'] },
      }),
      load: (id) => (id === resolvedEntry ? workerBridgeSource : undefined),
      name: 'nix-cache:alchemy-worker',
      resolveId: (id) => (id === entry ? resolvedEntry : undefined),
    },
  ],
  run: {
    tasks: {
      build: {
        cache: {
          input: [{ auto: true }, '!dist/**'],
          output: ['dist/**'],
        },
        command: 'vp build',
      },
      check: { command: 'vp check' },
      ci: { command: '', dependsOn: ['check', 'test'] },
      dev: { cache: false, command: 'alchemy dev --config alchemy.run.ts --no-input' },
      fix: { command: 'vp check --fix' },
      test: { command: 'vp test run', dependsOn: ['build'] },
    },
  },
  ssr: { noExternal: true },
  test: {
    dir: 'tests',
    testTimeout: 30_000,
  },
})
