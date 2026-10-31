# Nix package validation

This guide serves contributors and maintainers who validate the Worker, Nix packages, and cache configuration.
For cache installation and client use, see [README.md](../README.md).

## Source and reproducibility

`nix/shared/` is a verbatim snapshot of the six `.nix` files and `flake.lock` in `nix/share/packages` at monorepo commit [`fbac6164a547ef005115c0b5343e321940d6f45b`](https://github.com/totto2727-org/monorepo/tree/fbac6164a547ef005115c0b5343e321940d6f45b/nix/share/packages).
The upstream README is not copied.
The snapshot includes the original dependency hashes, nixpkgs pin, bun2nix pin, and shared overlay without overrides.
It was exported with `git archive HEAD nix/share/packages` and checked against the committed blobs, not the dirty working tree.
The monorepo was read-only throughout this work.

An immutable GitHub flake input was attempted first.
The public archive returned HTTP 404 on 2026-10-25, so this repository contains the source snapshot instead of requiring access to that repository in CI.
The `path:./shared` input is inside this repository and is covered by `nix/flake.lock`, not an absolute developer-machine path.
To update, replace the snapshot from a deliberate upstream commit, record its exact hash here, update `nix/flake.lock`, and run validation again.
Do not edit the vendored package definitions independently.

## Package boundary

| Package       | Pinned version | Safe smoke command                |
| ------------- | -------------- | --------------------------------- |
| pass-cli      | 0.20.0         | `pass-cli version`                |
| monid         | 0.1.7          | `monid --version`, `monid --help` |
| oo-cli (`oo`) | 1.9.8          | `oo version --json`, `oo --help`  |

The shared overlay does not export Vite Plus.
The monorepo instructions prohibit installing or wrapping Vite Plus with Nix.
The workflow therefore uses the official `voidzero-dev/setup-vp` action separately, without version, Node.js, or package-manager overrides and with `run-install: false`.
The same native job installs the project environment with `vp env install`, installs locked dependencies, configures optional cache reads, validates native packages, and runs `vp run ci`.
Task orchestration is defined once in `vite.config.ts`.
The root flake supplies only `nixfmt`, not JavaScript runtimes.
The Vite Plus installer selects its current official version, while `package.json` and the lockfile define the project's JavaScript tool and dependency requirements.

## Run locally

Run from the repository root:

```bash
vp env install
vp env current
vp install --frozen-lockfile
vp run nix:check
vp run nix:smoke
vp run ci
```

Install the official Vite+ CLI and Nix before these steps.
Vite+ owns Node.js and the package manager through `package.json`.
Install the locked JavaScript dependencies before using the Effect-based cache configuration helper.
`vp run nix:check` evaluates all configured systems without building them.
`vp run nix:smoke` builds and smoke-tests only the native system.
`vp run ci` runs checks and tests, with the Worker build included as a test prerequisite.
Compiled Worker checks and cache helper tests are part of the normal Vitest suite, not separate smoke scripts.

Build a single package with `nix build ./nix#pass-cli --no-link`, substituting `monid` or `oo-cli` as needed.
The smoke script builds the native outputs and then uses a temporary HOME and XDG directories for CLI invocations.
It never opens a vault, logs in, calls a connector, or runs a Monid endpoint.
The version assertions must be updated alongside intentional package upgrades.

## Native CI

`.github/workflows/nix-cache.yml` uses these native runners and asserts Nix's actual system before building:

| Runner           | Nix system     |
| ---------------- | -------------- |
| ubuntu-24.04     | x86_64-linux   |
| ubuntu-24.04-arm | aarch64-linux  |
| macos-15         | aarch64-darwin |

The workflow performs real `nix build` requests and executes the resulting binaries on each matching platform.
It runs on all pull requests and pushes to `main` without path filters, so application and test changes receive the same native validation.
The workflow installs the Vite+ project environment and locked dependencies before running the Effect cache helper through `vp run cache:configure`.
It then runs `vp run nix:check`, `vp run nix:smoke`, and `vp run ci` in the same native job.
The normal test task builds the Worker and includes compiled Alchemy bridge checks in real workerd without Cloudflare provisioning.
The integration suite starts local Miniflare/workerd with S3-compatible access to its R2 binding, pushes a store path with `nix copy --to s3://...`, pulls it through the authenticated Worker into a separate file store, and compares the NAR dumps.
The integration test uses temporary local credentials and does not require cloud secrets.
Substituted or already-realized outputs are valid native runnable outputs, but do not prove a fresh source compilation occurred.
`--all-systems --no-build` is evaluation only and is not Linux build evidence.
No remote builder is provisioned and no cloud-compute credits are used.

## Optional cache configuration

Normal builds require no Worker, Cloudflare credentials, or private cache.
Set repository variables `NIX_CACHE_URL` and `NIX_CACHE_PUBLIC_KEY` together to opt into an HTTPS signed substituter.
The URL must not contain credentials, a query string, or a fragment.
The helper preserves Nix's default public substituters and signature checks.
It does not configure upload credentials or disable signature verification.
For a cache protected by HTTP Basic authentication, optionally set GitHub secrets `NIX_CACHE_USERNAME` and `NIX_CACHE_PASSWORD` together.
The workflow maps them to `CACHE_USERNAME` and `CACHE_PASSWORD` only for the cache configuration step.
Both absent means anonymous access; an incomplete pair fails before writing configuration, even when no cache URL is set.
The helper creates a uniquely named netrc file under `RUNNER_TEMP`, sets mode `600`, and adds its path as `netrc-file` in the user Nix configuration.
The helper parses the URL with `Schema.URLFromString` and writes its normalized serialization to `extra-substituters`.
It uses the parsed hostname without the port or path as the netrc machine.
For IPv6 literals, it removes the URL brackets for libcurl's netrc format, for example `machine ::1` rather than `machine [::1]`.
Credentials must be nonempty safe configuration tokens without whitespace, controls, double quotes, backslashes, or `#`.
The username must not contain a colon, because HTTP Basic uses it as the username/password separator.
They are never written to the URL, repository, workflow output, or Nix configuration, and shell tracing is disabled before handling them.
The runner-temporary file remains available for later Nix build steps and is discarded when the hosted runner is destroyed.
For local use, provide an existing whitespace-free `RUNNER_TEMP` directory, supply the two credential environment variables securely, and remove the generated netrc file when finished.
This helper supports Basic authentication, not a Bearer-only Worker.
Do not put tokens in repository variables or commit a netrc file.

After installing the project environment and dependencies, provide settings securely and run:

```bash
CACHE_URL=https://cache.example.test CACHE_PUBLIC_KEY='cache.example.test-1:BASE64_KEY' vp run cache:configure
```

The helper itself configures reads and does not upload artifacts.
`tests/cache.test.ts` separately validates a local S3 push and authenticated Worker pull against Miniflare/workerd.
Actual deployed Cloudflare R2/Worker validation remains separate opt-in integration work.

## Current local evidence, 2026-10-31

The local test run passed all 85 tests across three files.
The suite includes HTTP/cache integration, Effect CLI configuration validation, and compiled Worker checks.
This is local validation, not evidence of a deployed Cloudflare roundtrip or successful execution of every native CI runner.

## Historical evidence, 2026-10-25

These observations describe the earlier implementation and tool setup, not the current command entry points or current test count.
Use the commands above for current validation.

- Native aarch64-darwin `nix build` succeeded for all three pinned packages, reusing outputs already in the local Nix store.
- Their safe version and help smoke commands passed, including assertions for versions 0.20.0, 0.1.7, and 1.9.8.
- The official local `~/.vite-plus/bin/vp` reported `vp v1.4.0` and its help command passed.
- That initial Vite Plus report showed no local `vite-plus` project installation at the time; the application pipeline is validated separately below.
- All three platforms passed derivation evaluation with `nix flake check --all-systems --no-build`.
- Cache configuration tests covered absent settings, incomplete settings, HTTP rejection, newline injection rejection, credential-bearing URL rejection, URL query/fragment rejection, and valid HTTPS configuration.
- Optional authentication tests covered both incomplete credential pairs, missing runner temporary directory, netrc injection rejection, colon-containing username rejection, exact machine/login/password content, mode `600`, and absence of credentials from output even when invoked with Bash tracing.
- Bash syntax checks passed.
- Nix reported aarch64-darwin as the local system, only x86_64-darwin as an extra platform, and `builders = @/etc/nix/machines`; that machines file was absent.
- Linux native builds and all GitHub workflow execution remain pending because no Linux builders were available and GitHub connector credentials were unavailable.
- Locked dependency installation, five integration tests, and the Worker build passed on aarch64-darwin.
- The integration suite confirmed a local S3 push and authenticated Worker pull roundtrip against Miniflare/workerd, including NAR dump comparison.
- The format/lint check, TypeScript check, five integration tests, Worker build, and then-separate compiled Worker smoke check passed. The compiled Alchemy bridge started in workerd, rejected unauthenticated access with 401, and queried its empty R2 binding with authenticated access returning 404.
- Actual deployed Cloudflare R2/Worker roundtrip validation remains pending, as do Linux native execution and GitHub CI execution.
