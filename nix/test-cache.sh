#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp
root=$(mktemp -d "$PWD/tmp/nix-cache-test.XXXXXX")
trap 'rm -rf "$root"' EXIT
export XDG_CONFIG_HOME="$root"
unset CACHE_URL CACHE_PUBLIC_KEY CACHE_USERNAME CACHE_PASSWORD
export RUNNER_TEMP="$root/runner"
mkdir -p "$RUNNER_TEMP"
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
for url in 'https://cache.example.test/path?token=value' 'https://cache.example.test/path#fragment'; do
  if CACHE_URL="$url" CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh; then
    echo 'Cache URL query or fragment was accepted.' >&2
    exit 1
  fi
done
CACHE_URL=https://cache.example.test CACHE_PUBLIC_KEY=example:key bash nix/configure-cache.sh
grep -Fx 'extra-substituters = https://cache.example.test' "$root/nix/nix.conf"
grep -Fx 'extra-trusted-public-keys = example:key' "$root/nix/nix.conf"
if grep -q '^netrc-file = ' "$root/nix/nix.conf"; then
  echo 'Anonymous configuration unexpectedly enables netrc authentication.' >&2
  exit 1
fi

# Authentication must be all-or-nothing, including when no cache is configured.
export XDG_CONFIG_HOME="$root/auth-config"
for missing in username password; do
  unset CACHE_USERNAME CACHE_PASSWORD
  if [[ "$missing" == username ]]; then
    export CACHE_PASSWORD=fixture-password
  else
    export CACHE_USERNAME=fixture-user
  fi
  if bash nix/configure-cache.sh > "$root/output" 2>&1; then
    echo 'Incomplete authentication was accepted.' >&2
    exit 1
  fi
  test ! -e "$XDG_CONFIG_HOME/nix/nix.conf"
done
export CACHE_USERNAME=fixture-user CACHE_PASSWORD=fixture-password
if bash nix/configure-cache.sh > "$root/output" 2>&1; then
  echo 'Credentials without cache configuration were accepted.' >&2
  exit 1
fi
test ! -e "$XDG_CONFIG_HOME/nix/nix.conf"
export CACHE_URL=https://cache.example.test:443/prefix CACHE_PUBLIC_KEY=example:key
if RUNNER_TEMP= bash nix/configure-cache.sh > "$root/output" 2>&1; then
  echo 'Authentication without RUNNER_TEMP was accepted.' >&2
  exit 1
fi
if CACHE_PASSWORD=$'bad\npassword' bash nix/configure-cache.sh > "$root/output" 2>&1; then
  echo 'Netrc credential injection was accepted.' >&2
  exit 1
fi
if CACHE_USERNAME=reader:unexpected bash nix/configure-cache.sh > "$root/output" 2>&1; then
  echo 'Basic authentication username containing a colon was accepted.' >&2
  exit 1
fi
test ! -e "$XDG_CONFIG_HOME/nix/nix.conf"
bash -x nix/configure-cache.sh > "$root/output" 2>&1
if grep -qE 'fixture-user|fixture-password' "$root/output"; then
  echo 'Credentials appeared in command output.' >&2
  exit 1
fi
netrc=$(awk '/^netrc-file = / { print $3 }' "$XDG_CONFIG_HOME/nix/nix.conf")
[[ "$netrc" == "$RUNNER_TEMP"/nix-cache.* ]]
[[ "$(ls -ld "$netrc")" == -rw-------* ]]
printf 'machine cache.example.test\nlogin fixture-user\npassword fixture-password\n' > "$root/expected-netrc"
cmp "$root/expected-netrc" "$netrc"
grep -Fx 'extra-substituters = https://cache.example.test:443/prefix' "$XDG_CONFIG_HOME/nix/nix.conf"
