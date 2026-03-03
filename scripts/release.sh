#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/src/cli.ts"
OUT_DIR="${REPO_ROOT}/dist/release"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but was not found in PATH." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

build_target() {
  local target="$1"
  local output="$2"

  echo "Building ${output} (${target})..."
  bun build \
    --compile \
    --minify \
    --bytecode \
    "${ENTRYPOINT}" \
    --target="${target}" \
    --outfile="${OUT_DIR}/${output}"
  chmod +x "${OUT_DIR}/${output}"
}

build_target "bun-darwin-arm64" "cook-darwin-arm64"
build_target "bun-darwin-x64" "cook-darwin-x64"
build_target "bun-linux-x64" "cook-linux-x64"

echo
echo "Release binaries written to ${OUT_DIR}:"
ls -lh "${OUT_DIR}"
