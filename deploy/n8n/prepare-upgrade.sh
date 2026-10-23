#!/usr/bin/env bash
set -euo pipefail
umask 022

# Prepare an isolated runtime only. This script never changes service settings,
# the existing global Node installation, or the n8n application data directory.
node_version=24.21.0
n8n_version=2.38.6
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
runtime_root=/opt/n8n/runtime
node_root="${runtime_root}/node-v${node_version}-linux-x64"
release_root="/opt/n8n/releases/${n8n_version}"

test "$(uname -m)" = x86_64
test ! -e "$release_root"
test ! -e "$node_root"
mkdir -p "$runtime_root"
download_root=$(mktemp -d "${runtime_root}/download.XXXXXXXX")

curl --fail --location --retry 2 --connect-timeout 20 --max-time 300 \
  "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
  --output "${download_root}/SHASUMS256.txt"
official_sha256=$(awk -v archive="$node_archive" '$2 == archive {print $1}' "${download_root}/SHASUMS256.txt")
test "$official_sha256" = "$node_sha256"
curl --fail --location --retry 2 --connect-timeout 20 --max-time 600 \
  "https://nodejs.org/dist/v${node_version}/${node_archive}" \
  --output "${download_root}/${node_archive}"
actual_sha256=$(sha256sum "${download_root}/${node_archive}" | awk '{print $1}')
test "$actual_sha256" = "$node_sha256"
tar -xJf "${download_root}/${node_archive}" -C "$runtime_root"
"${node_root}/bin/node" --version

mkdir -p "$release_root"
export PATH="${node_root}/bin:${PATH}"
export NODE_OPTIONS=--max-old-space-size=768
npm install --prefix "$release_root" --cache "${runtime_root}/npm-cache" \
  --no-audit --no-fund --loglevel=error "n8n@${n8n_version}"

N8N_USER_FOLDER="${runtime_root}/version-check" \
  "${node_root}/bin/node" "${release_root}/node_modules/n8n/bin/n8n" --version
/usr/bin/node --version
printf 'Prepared Node runtime: %s\nPrepared n8n release: %s\n' "$node_root" "$release_root"
