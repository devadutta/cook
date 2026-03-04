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

need_cmd uname
need_cmd chmod
need_cmd mkdir
need_cmd mv
need_cmd rm
need_cmd mktemp

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *)
    echo "Error: unsupported operating system: $OS" >&2
    echo "Supported: macOS and Linux" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH" >&2
    echo "Supported: arm64 and x86_64/amd64" >&2
    exit 1
    ;;
esac

ASSET="$BINARY_NAME-$PLATFORM-$ARCH"

if [ "$PLATFORM" = "linux" ] && [ "$ARCH" = "arm64" ]; then
  echo "Error: no Linux arm64 release asset published for cook yet." >&2
  echo "Available release assets: cook-darwin-arm64, cook-darwin-x64, cook-linux-x64" >&2
  exit 1
fi

URL="$DOWNLOAD_BASE/$ASSET"
TMP_DIR="$(mktemp -d)"
TMP_FILE="$TMP_DIR/$BINARY_NAME"

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
  exit 1
}

echo "Installing $BINARY_NAME from $URL"
download

chmod +x "$TMP_FILE"
mkdir -p "$INSTALL_DIR"
mv "$TMP_FILE" "$INSTALL_DIR/$BINARY_NAME"

echo
echo "Installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "Run: $BINARY_NAME --version"
    ;;
  *)
    echo "Note: $INSTALL_DIR is not in your PATH."
    echo "Add it to your shell profile, then run: $BINARY_NAME --version"
    ;;
esac
