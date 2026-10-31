#!/usr/bin/env bash
set +x
exec node "${BASH_SOURCE[0]%/*}/configure-cache.ts"
