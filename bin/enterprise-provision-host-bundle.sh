#!/usr/bin/env bash
# Bundle scripts/enterprise-provision-host.ts into one node 24 file that runs
# on a plain linux host with no node_modules (the provision service on bos-laptop).
#   bin/enterprise-provision-host-bundle.sh [out.mjs]
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-.enterprise-build/enterprise-provision-host.mjs}
mkdir -p "$(dirname "$out")"
node_modules/.bin/esbuild scripts/enterprise-provision-host.ts --bundle --platform=node --target=node24 --format=esm \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$out" --log-level=warning
echo "$out"
