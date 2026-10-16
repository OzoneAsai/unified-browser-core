#!/usr/bin/env bash
# Isolated synthetic tests. No access to Obsidian or user browser profiles.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PREFIX="${NODE_PREFIX:-$(brew --prefix node)}"
NODE_ABI="$(node -p 'process.versions.modules')"
if [[ ! -f "$NODE_PREFIX/lib/libnode.${NODE_ABI}.dylib" ]]; then
  echo "Missing libnode.${NODE_ABI}.dylib at $NODE_PREFIX/lib" >&2
  exit 1
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ubc-v8-snapshot-proof-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
clang++ -std=c++20 -Wno-deprecated-declarations \
  -I"$NODE_PREFIX/include/node" \
  "$DIR/native-context-snapshot.cc" \
  -L"$NODE_PREFIX/lib" "-lnode.${NODE_ABI}" \
  "-Wl,-rpath,$NODE_PREFIX/lib" \
  -o "$TMP/context-native"
printf '\n--- Process 1: write a V8 startup/context blob ---\n'
"$TMP/context-native" build "$TMP/context.blob"
printf '\n--- Process 2: load blob and rebind the host wrapper ---\n'
"$TMP/context-native" load "$TMP/context.blob"
printf '\n--- Process 3: reject an untrusted origin binding ---\n'
"$TMP/context-native" load-wrong-origin "$TMP/context.blob"
printf '\n--- Live Heap Object ID injection test ---\n'
node "$DIR/live-inspector-heap.mjs"
