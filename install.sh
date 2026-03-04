#!/bin/sh
set -eu

cat <<'EOF'
-----------------------------------------
                              oooo        
                              `888        
 .ooooo.   .ooooo.   .ooooo.   888  oooo  
d88' `"Y8 d88' `88b d88' `88b  888 .8P'   
888       888   888 888   888  888888.    
888   .o8 888   888 888   888  888 `88b.  
`Y8bod8P' `Y8bod8P' `Y8bod8P' o888o o888o 
                                          
 Thank you for installing cook ai agent
-----------------------------------------


EOF
                                          
REPO_OWNER="devadutta"
REPO_NAME="cook"
DEFAULT_VERSION="v0.1.0"
RELEASE_BINARY_NAME="cook"

VERSION="${COOK_VERSION:-$DEFAULT_VERSION}"
INSTALL_DIR="${COOK_INSTALL_DIR:-$HOME/.cook/bin}"
BINARY_NAME="${COOK_BIN_NAME:-cook}"

if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_BASE="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download"
else
  DOWNLOAD_BASE="https://github.com/$REPO_OWNER/$REPO_NAME/releases/download/$VERSION"
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

print_source_build_help() {
  echo "Please build cook from source:" >&2
  echo "  https://github.com/$REPO_OWNER/$REPO_NAME" >&2
  echo "Quick start:" >&2
  echo "  1) bun install" >&2
  echo "  2) bun run build:compile" >&2
}

unsupported_platform() {
  platform="$1"
  reason="${2:-}"

  echo "No prebuilt binary is available for your platform: $platform" >&2
  if [ -n "$reason" ]; then
    echo "$reason" >&2
  fi
  print_source_build_help
  exit 1
}

detect_linux_libc() {
  if command -v ldd >/dev/null 2>&1; then
    # `ldd --version` output varies by libc implementation.
    ldd_output="$(ldd --version 2>&1 || true)"
    case "$ldd_output" in
      *musl*)
        echo "musl"
        return
        ;;
      *glibc*|*GNU*|*GNU\ C\ Library*)
        echo "glibc"
        return
        ;;
    esac
  fi

  if [ -f /etc/alpine-release ]; then
    echo "musl"
    return
  fi

  echo "glibc"
}

detect_linux_avx2() {
  if command -v lscpu >/dev/null 2>&1; then
    if LC_ALL=C lscpu 2>/dev/null | grep -qiE '(^|[[:space:]])avx2([[:space:]]|$)'; then
      echo "yes"
      return
    fi
  fi

  if command -v grep >/dev/null 2>&1 && [ -r /proc/cpuinfo ]; then
    if grep -qiE '(^flags|^Features)[[:space:]]*:.*(^|[[:space:]])avx2([[:space:]]|$)' /proc/cpuinfo; then
      echo "yes"
      return
    fi
  fi

  echo "no"
}

need_cmd uname
need_cmd chmod
need_cmd mkdir
need_cmd mv
need_cmd rm
need_cmd mktemp

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"
LIBC=""

case "$OS_RAW" in
  Darwin)
    OS="darwin"
    ;;
  Linux)
    OS="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    OS="windows"
    ;;
  *)
    unsupported_platform "$OS_RAW/$ARCH_RAW"
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    unsupported_platform "$OS_RAW/$ARCH_RAW"
    ;;
esac

if [ "$OS" = "linux" ]; then
  LIBC="$(detect_linux_libc)"
fi

case "$OS:$ARCH" in
  darwin:arm64)
    ASSET="${RELEASE_BINARY_NAME}-darwin-arm64"
    ;;
  darwin:x64)
    ASSET="${RELEASE_BINARY_NAME}-darwin-x64"
    ;;
  linux:x64)
    if [ "$LIBC" = "musl" ]; then
      ASSET="${RELEASE_BINARY_NAME}-linux-x64-musl"
    else
      if [ "$(detect_linux_avx2)" = "yes" ]; then
        ASSET="${RELEASE_BINARY_NAME}-linux-x64"
      else
        ASSET="${RELEASE_BINARY_NAME}-linux-x64-baseline"
      fi
    fi
    ;;
  linux:arm64)
    if [ "$LIBC" = "musl" ]; then
      unsupported_platform "$OS_RAW/$ARCH_RAW (musl)" "The release matrix currently provides Linux arm64 glibc binaries only."
    fi
    ASSET="${RELEASE_BINARY_NAME}-linux-arm64"
    ;;
  windows:x64)
    ASSET="${RELEASE_BINARY_NAME}-windows-x64.exe"
    ;;
  *)
    unsupported_platform "$OS_RAW/$ARCH_RAW"
    ;;
esac

URL="$DOWNLOAD_BASE/$ASSET"
TMP_DIR="$(mktemp -d)"
TMP_FILE="$TMP_DIR/$ASSET"

INSTALL_NAME="$BINARY_NAME"
if [ "$OS" = "windows" ]; then
  case "$INSTALL_NAME" in
    *.exe)
      ;;
    *)
      INSTALL_NAME="${INSTALL_NAME}.exe"
      ;;
  esac
fi
INSTALL_PATH="$INSTALL_DIR/$INSTALL_NAME"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fLsS "$URL" -o "$TMP_FILE"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_FILE" "$URL"
    return
  fi

  echo "Error: neither curl nor wget is installed." >&2
  print_source_build_help
  exit 1
}

echo "Installing $BINARY_NAME from $URL"
if ! download; then
  echo "Error: failed to download prebuilt binary from $URL" >&2
  print_source_build_help
  exit 1
fi

if [ ! -s "$TMP_FILE" ]; then
  echo "Error: downloaded file is empty: $TMP_FILE" >&2
  print_source_build_help
  exit 1
fi

chmod +x "$TMP_FILE"
mkdir -p "$INSTALL_DIR"
mv "$TMP_FILE" "$INSTALL_PATH"

echo
echo "Installed $BINARY_NAME to $INSTALL_PATH"
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "Run: $INSTALL_NAME --version"
    ;;
  *)
    echo "Note: $INSTALL_DIR is not in your PATH."
    echo "Add it to your shell profile, then run: $INSTALL_NAME --version"
    ;;
esac
