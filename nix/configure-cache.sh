#!/usr/bin/env bash
set +x
set -euo pipefail

# Validate everything before writing configuration or credential files.
if [[ -n "${CACHE_USERNAME:-}" || -n "${CACHE_PASSWORD:-}" ]]; then
  if [[ -z "${CACHE_USERNAME:-}" || -z "${CACHE_PASSWORD:-}" || -z "${RUNNER_TEMP:-}" ]]; then
    echo 'Cache authentication requires both credentials and RUNNER_TEMP.' >&2
    exit 1
  fi
  for value in "$CACHE_USERNAME" "$CACHE_PASSWORD"; do
    if [[ "$value" =~ [[:space:]] || "$value" == *'"'* || "$value" == *'\'* ]]; then
      echo 'Cache credentials must be single netrc tokens without quotes or backslashes.' >&2
      exit 1
    fi
  done
fi

# Optional read-only cache. Empty configuration keeps normal public substitutes.
if [[ -z "${CACHE_URL:-}" && -z "${CACHE_PUBLIC_KEY:-}" && -z "${CACHE_USERNAME:-}" && -z "${CACHE_PASSWORD:-}" ]]; then
  exit 0
fi
if [[ "${CACHE_URL:-}" != https://* || -z "${CACHE_PUBLIC_KEY:-}" || "$CACHE_URL" =~ [[:space:]] || "$CACHE_PUBLIC_KEY" =~ [[:space:]] || "$CACHE_URL" == *@* ]]; then
  echo 'Set both a credential-free HTTPS CACHE_URL and a whitespace-free CACHE_PUBLIC_KEY.' >&2
  exit 1
fi
authority=${CACHE_URL#https://}
authority=${authority%%/*}
if [[ ! "$authority" =~ ^([a-zA-Z0-9][a-zA-Z0-9.-]*)(:[0-9]+)?$ ]]; then
  echo 'Cache URL must have a DNS hostname and optional numeric port.' >&2
  exit 1
fi
host=${BASH_REMATCH[1]}
config="${XDG_CONFIG_HOME:-$HOME/.config}/nix/nix.conf"
mkdir -p "${config%/*}"
if [[ -n "${CACHE_USERNAME:-}" ]]; then
  if [[ ! -d "$RUNNER_TEMP" || "$RUNNER_TEMP" =~ [[:space:]] ]]; then
    echo 'RUNNER_TEMP must be an existing directory with no whitespace.' >&2
    exit 1
  fi
  # mktemp prevents following a pre-existing symlink; umask protects at creation.
  umask 077
  netrc=$(mktemp "$RUNNER_TEMP/nix-cache.XXXXXX")
  chmod 600 "$netrc"
  printf 'machine %s\nlogin %s\npassword %s\n' "$host" "$CACHE_USERNAME" "$CACHE_PASSWORD" > "$netrc"
  printf '\nnetrc-file = %s\n' "$netrc" >> "$config"
fi
printf '\nextra-substituters = %s\nextra-trusted-public-keys = %s\n' "$CACHE_URL" "$CACHE_PUBLIC_KEY" >> "$config"
