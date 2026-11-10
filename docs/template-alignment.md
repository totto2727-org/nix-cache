# Template alignment

## Baseline

Common configuration follows `template/vite-plus-app` at `70c95e4f874019368e88df0d7070eff3698665ac` and `template/vite-plus-lib` at `bfe72427c4507d17d76da37506476641f9669c9c`.
These are configuration references, not an upstream runtime fork.
The Worker implementation and Cloudflare deployment model remain application-specific.

- Use the app template's Node.js `26.7.0` pin and `>=26` engine, both templates' pnpm `11.21.0`, and Vite+ `1.1.0` catalog with matching Vite core and Vitest overrides.
- Preserve the strict 1440-minute dependency release-age policy.
- Extend `@tsconfig/strictest` and `@tsconfig/node-ts` without disabling inherited checks.
- Use the common formatter, import sorting, package sorting, and type-aware/type-checking linter configuration.
- Use the library template's locked Nix development shell, `.envrc`, and hook-free `ci` shell, without adding JavaScript tools to Nix.
- Keep a single public `ubuntu-latest` check job, shared setup actions, and `nix print-dev-env` before `vp run ci`.
- Keep checkout credential defaults as explicitly requested, rather than copying the templates' `persist-credentials: false` setting.

## Required application differences

| Area                  | Difference and reason                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product metadata      | Private Worker application, not a Node.js CLI or publishable library. No CLI `bin`, npm exports, `package.nix`, executable packaging, or publication task is needed.                                                                                                                                                       |
| Build                 | Keep Alchemy's Cloudflare plugin, virtual Worker bridge, SSR bundling, Cloudflare externals, and `dist/ssr` output. Template Node or library packaging would produce the wrong runtime artifact.                                                                                                                           |
| TypeScript            | Use ESNext modules and bundler resolution for extensionless Worker imports and Vite plugins. Keep DOM libraries, Vite+ client types, and test/config inclusion for the runtime adapters.                                                                                                                                   |
| Dependencies          | Keep Effect, Alchemy, Cloudflare runtime/types, Miniflare, and the explicit matching Vite/Vitest dependencies required by the Worker build and tests.                                                                                                                                                                      |
| Lifecycle scripts     | Allow only `workerd`, whose installation validates the platform executable used by Miniflare tests. Vite+ remains denied. Do not retain unused esbuild allowances.                                                                                                                                                         |
| Tasks                 | Keep Alchemy development non-cacheable and use template cache defaults for checks, fixes, tests, and CI. The Worker build excludes `dist/**` from inputs and declares it as restored output. Tests depend on the Worker build and run local workerd/R2 and real Nix fixtures. All orchestration stays in `vite.config.ts`. |
| Secrets and artifacts | Ignore Alchemy state, local credential files, generated Worker output, Nix results, and temporary output. No deployment or cloud-resource mutation belongs in CI.                                                                                                                                                          |

## Verification boundaries

`vp install --frozen-lockfile` verifies reproducible dependency installation.
`vp run ci` checks formatting, lint/types, the compiled Worker, local R2 and Cache API behavior, and the real Nix fixture roundtrip.
`nix flake check --no-build` evaluates the native shell outputs, and `nix develop .#ci --command nixfmt --check flake.nix` builds and checks the native development environment.
Native macOS validation is not evidence of a Linux build, a hosted GitHub Actions run, or a deployed Cloudflare roundtrip.
