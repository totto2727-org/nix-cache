#!/usr/bin/env bash
set -euo pipefail

# Build with the caller's Nix configuration, then isolate CLI state.
flake="${VALIDATION_FLAKE:-./nix}"
pass_cli=$(nix build "$flake#pass-cli" --no-link --print-out-paths)
monid=$(nix build "$flake#monid" --no-link --print-out-paths)
oo_cli=$(nix build "$flake#oo-cli" --no-link --print-out-paths)

# Run only local metadata commands, never login, vault access, or API calls.
mkdir -p tmp
export HOME="$(mktemp -d "$PWD/tmp/nix-smoke.XXXXXX")"
trap 'rm -rf "$HOME"' EXIT
export CI=true
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
unset OO_API_KEY MONID_API_KEY

"$pass_cli/bin/pass-cli" version | tee "$HOME/pass-version"
grep -F '0.20.0' "$HOME/pass-version"
"$monid/bin/monid" --version | tee "$HOME/monid-version"
grep -F '0.1.7' "$HOME/monid-version"
"$monid/bin/monid" --help
"$oo_cli/bin/oo" version --json | tee "$HOME/oo-version"
grep -F '1.9.8' "$HOME/oo-version"
"$oo_cli/bin/oo" --help
