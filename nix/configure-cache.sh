#!/usr/bin/env bash
set -euo pipefail

# Optional read-only cache. Empty configuration keeps normal public substitutes.
if [[ -z "${CACHE_URL:-}" && -z "${CACHE_PUBLIC_KEY:-}" ]]; then
  exit 0
fi
if [[ "${CACHE_URL:-}" != https://* || -z "${CACHE_PUBLIC_KEY:-}" || "$CACHE_URL" =~ [[:space:]] || "$CACHE_PUBLIC_KEY" =~ [[:space:]] || "$CACHE_URL" == *@* ]]; then
  echo 'Set both a credential-free HTTPS CACHE_URL and a whitespace-free CACHE_PUBLIC_KEY.' >&2
  exit 1
fi
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/nix"
printf '\nextra-substituters = %s\nextra-trusted-public-keys = %s\n' "$CACHE_URL" "$CACHE_PUBLIC_KEY" >> "${XDG_CONFIG_HOME:-$HOME/.config}/nix/nix.conf"
