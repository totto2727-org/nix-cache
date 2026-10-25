#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp
root=$(mktemp -d "$PWD/tmp/nix-cache-test.XXXXXX")
trap 'rm -rf "$root"' EXIT
export XDG_CONFIG_HOME="$root"
unset CACHE_URL CACHE_PUBLIC_KEY
bash nix/configure-cache.sh
test ! -e "$root/nix/nix.conf"
if CACHE_URL=https://cache.example.test bash nix/configure-cache.sh; then
  echo 'Incomplete cache configuration was accepted.' >&2
  exit 1
fi
if CACHE_URL=http://cache.example.test CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh; then
  echo 'Non-HTTPS cache configuration was accepted.' >&2
  exit 1
fi
if CACHE_URL=$'https://cache.example.test\nrequire-sigs = false' CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh; then
  echo 'Multi-line cache configuration was accepted.' >&2
  exit 1
fi
if CACHE_URL=https://token@cache.example.test CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh; then
  echo 'Credentials in a cache URL were accepted.' >&2
  exit 1
fi
CACHE_URL=https://cache.example.test CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh
grep -Fx 'extra-substituters = https://cache.example.test' "$root/nix/nix.conf"
grep -Fx 'extra-trusted-public-keys = example:key' "$root/nix/nix.conf"
