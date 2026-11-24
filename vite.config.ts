import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import preset from '@totto2727/oxlint/preset/application'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

// oxlint-disable-next-line import/no-default-export -- Vite+ loads the configuration from the module default.
export default defineConfig({
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
    overrides: [
      {
        // An ambient Workerd module declaration must be a script in the Node host type program.
        files: ['tests/workerd-runtime.d.ts'],
        plugins: ['import'],
        rules: { 'import/unambiguous': 'off' },
      },
    ],
  },
  run: {
    tasks: {
      build: {
        cache: {
          input: [{ auto: true }, '!dist/**'],
          output: ['dist/**'],
        },
        command: 'node scripts/build-worker.ts',
      },
      check: { command: 'vp check' },
      ci: { command: '', dependsOn: ['check', 'test'] },
      dev: { cache: false, command: 'alchemy dev --config alchemy.run.ts --no-input' },
      fix: { command: 'vp check --fix' },
      test: { command: 'vp test run', dependsOn: ['build'] },
    },
  },
  test: {
    dir: 'tests',
    testTimeout: 30_000,
  },
})
