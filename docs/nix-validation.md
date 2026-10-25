# Nix package validation

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

| Package | Pinned version | Safe smoke command |
| --- | --- | --- |
| pass-cli | 0.20.0 | `pass-cli version` |
| monid | 0.1.7 | `monid --version`, `monid --help` |
| oo-cli (`oo`) | 1.9.8 | `oo version --json`, `oo --help` |

The shared overlay does not export Vite Plus.
The monorepo instructions prohibit installing or wrapping Vite Plus with Nix.
The workflow therefore uses the official `voidzero-dev/setup-vp` action separately, without version, Node.js, or package-manager overrides and with `run-install: false`.
Its smoke commands are `vp --version` and `vp --help`, not application builds or package installation.
The Vite Plus installer selects its current official version, so only the three Nix package versions are locked here.

## Run locally

Run from the repository root:

```bash
nix flake check ./nix --all-systems --no-build --no-update-lock-file
bash nix/test-cache.sh
bash nix/smoke.sh
vp --version
vp --help
```

Build a single package with `nix build ./nix#pass-cli --no-link`, substituting `monid` or `oo-cli` as needed.
The smoke script builds the native outputs and then uses a temporary HOME and XDG directories for CLI invocations.
It never opens a vault, logs in, calls a connector, or runs a Monid endpoint.
The version assertions must be updated alongside intentional package upgrades.

## Native CI

`.github/workflows/nix-cache.yml` uses these native runners and asserts Nix's actual system before building:

| Runner | Nix system |
| --- | --- |
| ubuntu-24.04 | x86_64-linux |
| ubuntu-24.04-arm | aarch64-linux |
| macos-15 | aarch64-darwin |

The workflow performs real `nix build` requests and executes the resulting binaries on each matching platform.
Substituted or already-realized outputs are valid native runnable outputs, but do not prove a fresh source compilation occurred.
`--all-systems --no-build` is evaluation only and is not Linux build evidence.
No remote builder is provisioned and no cloud-compute credits are used.

## Optional cache configuration

Normal builds require no Worker, Cloudflare credentials, or private cache.
Set repository variables `NIX_CACHE_URL` and `NIX_CACHE_PUBLIC_KEY` together to opt into an HTTPS signed substituter.
The URL must not contain credentials.
The helper preserves Nix's default public substituters and signature checks.
It does not configure upload credentials or disable signature verification.
A private cache that requires an Authorization header needs separately provisioned Nix-compatible authentication, such as a restricted `netrc-file`.
Do not put tokens in the repository variables above or commit a netrc file.

For local reuse:

```bash
CACHE_URL=https://cache.example.test CACHE_PUBLIC_KEY='cache.example.test-1:BASE64_KEY' bash nix/configure-cache.sh
```

This is a read configuration, not a cache roundtrip test.
Authenticated upload, empty-store download, and private Worker roundtrip validation remain separate opt-in integration work.

## Observed evidence, 2026-10-25

- Native aarch64-darwin `nix build` succeeded for all three pinned packages, reusing outputs already in the local Nix store.
- Their safe version and help smoke commands passed, including assertions for versions 0.20.0, 0.1.7, and 1.9.8.
- The official local `~/.vite-plus/bin/vp` reported `vp v1.4.0` and its help command passed.
- That Vite Plus report showed no local `vite-plus` project installation at the time, so this proves the official CLI runs, not a project toolchain build.
- All three platforms passed derivation evaluation with `nix flake check --all-systems --no-build`.
- Cache configuration tests covered absent settings, incomplete settings, HTTP rejection, newline injection rejection, and valid HTTPS configuration.
- Bash syntax checks passed.
- Nix reported aarch64-darwin as the local system, only x86_64-darwin as an extra platform, and `builders = @/etc/nix/machines`; that machines file was absent.
- Linux native builds and all GitHub workflow execution remain pending because no Linux builders were available and GitHub connector credentials were unavailable.
- No authenticated Worker cache roundtrip was performed.
