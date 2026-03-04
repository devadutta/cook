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
  local output_base="$2"
  local output_path="${OUT_DIR}/${output_base}"
  local final_output="${output_path}"

  if [[ "${target}" == bun-windows-* ]]; then
    final_output="${output_path}.exe"
  fi

  echo "Building $(basename "${final_output}") (${target})..."
  bun build \
    --compile \
    --minify \
    --bytecode \
    "${ENTRYPOINT}" \
    --target="${target}" \
    --outfile="${output_path}"

  if [[ "${target}" != bun-windows-* ]]; then
    chmod +x "${final_output}"
  fi
}

TARGET_MATRIX=(
  "bun-darwin-arm64:cook-darwin-arm64"
  "bun-darwin-x64-baseline:cook-darwin-x64"
  "bun-linux-x64-baseline:cook-linux-x64"
  "bun-linux-x64-musl-baseline:cook-linux-x64-musl"
  "bun-linux-arm64:cook-linux-arm64"
  "bun-windows-x64-baseline:cook-windows-x64"
)

for entry in "${TARGET_MATRIX[@]}"; do
  IFS=':' read -r target output_base <<< "${entry}"
  build_target "${target}" "${output_base}"
done

echo
echo "Release binaries written to ${OUT_DIR}:"
ls -lh "${OUT_DIR}"
