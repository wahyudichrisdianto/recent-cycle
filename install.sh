#!/usr/bin/env bash
#
# Recent Cycle installer
#
# Fetches the packaged extension from GitHub Releases (or an override URL),
# installs it locally, and on macOS optionally builds + registers the local
# keyboard companion (Native Messaging host).
#
# One-liners:
#   Full install:
#     curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash
#   Clean reinstall:
#     curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash -s -- --clean
#   Companion only:
#     curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash -s -- --companion-only --extension-id <id>
#
# Self-hosted mirror (Apache/nginx web root):
#   RECENT_CYCLE_BASE_URL=https://elph.space curl -fsSL .../install.sh | bash
#
set -euo pipefail

REPO="wahyudichrisdianto/recent-cycle"
APP_DIR="${RECENT_CYCLE_DIR:-${HOME}/Library/Application Support/Recent Cycle}"
EXT_DIR="${APP_DIR}/extension"
HOST_NAME="com.recentcycle.keyboard"

MODE="full"                # full | clean | companion-only
INSTALL_COMPANION=1
EXT_ID=""
PACKAGE_URL=""
VERSION=""

log()  { printf '\033[1;32m==> %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Recent Cycle installer

USAGE
  curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash [-s -- [options]]

OPTIONS
  --clean
      Remove any existing Recent Cycle install first, then do a full install.

  --companion-only
      Install only the local macOS keyboard companion (Native Messaging host)
      without touching an already-installed extension.

  --extension-id <id>
      Provide the 32-character extension id explicitly instead of detecting it.

  --no-companion
      Extract the extension only; skip the native companion (browser-only mode).

  --version <ver>
      Pin the download to a tagged release (e.g. 0.1.0) instead of the latest.

  --package-url <url>
      Download the bundle from an explicit URL.

  -h, --help
      Show this help.
EOF
  exit 0
}

sha256hex() {
  local input="$1" hex
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$input" | shasum -a 256 | sed 's/ .*//'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$input" | sha256sum | sed 's/ .*//'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$input" | openssl dgst -sha256 | sed 's/^.*= *//'
  else
    return 1
  fi
}

# Chrome derives a stable id for unpacked extensions from the absolute path.
# id = base16(sha256(path))[0:32], each nibble -> a-p.
extension_id_for_path() {
  local hex chars="" c i
  hex="$(sha256hex "$1")" || return 1
  hex="${hex:0:32}"
  for (( i = 0; i < 32; i++ )); do
    c="${hex:i:1}"
    case "$c" in
      0) chars+="a";; 1) chars+="b";; 2) chars+="c";; 3) chars+="d";;
      4) chars+="e";; 5) chars+="f";; 6) chars+="g";; 7) chars+="h";;
      8) chars+="i";; 9) chars+="j";; a) chars+="k";; b) chars+="l";;
      c) chars+="m";; d) chars+="n";; e) chars+="o";; f) chars+="p";;
    esac
  done
  printf '%s' "$chars"
}

resolve_package_url() {
  local tag
  if [[ -n "${PACKAGE_URL}" ]]; then
    printf '%s' "$PACKAGE_URL"; return 0
  fi
  if [[ -n "${RECENT_CYCLE_PACKAGE_URL:-}" ]]; then
    printf '%s' "$RECENT_CYCLE_PACKAGE_URL"; return 0
  fi
  if [[ -n "${RECENT_CYCLE_BASE_URL:-}" ]]; then
    printf '%s/recent-cycle.zip' "$RECENT_CYCLE_BASE_URL"; return 0
  fi
  if [[ -n "$VERSION" ]]; then
    printf 'https://github.com/%s/releases/download/v%s/recent-cycle-%s.zip' "$REPO" "$VERSION" "$VERSION"
    return 0
  fi
  tag="$(curl -fsSL --retry 3 "https://api.github.com/repos/${REPO}/releases/latest" \
         | sed -n 's/^[[:space:]]*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  if [[ -n "$tag" ]]; then
    printf 'https://github.com/%s/releases/download/%s/recent-cycle-%s.zip' "$REPO" "$tag" "${tag#v}"
    return 0
  fi
  die 'could not resolve the latest release; set RECENT_CYCLE_PACKAGE_URL or --package-url explicitly'
}

fetch_package() {  # $1 url -> prints local zip path
  local url="$1" dir zipfile
  command -v curl >/dev/null 2>&1 || die "curl is required"
  dir="$(mktemp -d)"
  zipfile="${dir}/package.zip"
  log "Downloading ${url}"
  curl -fsSL --retry 3 -L "$url" -o "$zipfile" || die "download failed: ${url}"
  printf '%s' "$zipfile"
}

single_extension_dir() {  # $1 unpack dir -> prints the extension folder (has manifest.json)
  local dir="$1" cand top=()
  for cand in "${dir}"/*/; do
    [[ -f "${cand}manifest.json" ]] && top+=("$cand")
  done
  if [[ ${#top[@]} -ne 1 ]]; then
    die "expected the package to contain exactly one extension folder"
  fi
  printf '%s' "${top[0]}"
}

resolve_extension_id() {
  if [[ -d "$EXT_DIR" && -f "$EXT_DIR/manifest.json" ]]; then
    extension_id_for_path "$EXT_DIR" && return 0
  fi
  local host_manifest="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
  if [[ -f "$host_manifest" ]]; then
    local id
    id="$(sed -n 's/.*chrome-extension:\/\/*\([a-p]\{32\}\).*/\1/p' "$host_manifest" | head -1)"
    [[ -n "$id" ]] && { printf '%s' "$id"; return 0; }
  fi
  return 1
}

install_companion() {  # $1 -> native source dir, $2 -> extension id
  local native_dir="$1" id="$2"
  local os
  os="$(uname -s)"
  [[ "$os" == "Darwin" ]] || { warn "The companion is macOS-only; skipping on $os."; return 0; }
  [[ -d "$native_dir" ]] || die "package has no native/ directory"
  command -v zsh >/dev/null 2>&1 || die "zsh is required to install the companion"
  if ! EXT_ID="$(extension_id_for_path "$EXT_DIR")"; then
    EXT_ID="$id"
  fi
  log "Installing the macOS keyboard companion (extension id: $EXT_ID)"
  zsh "$native_dir/install.sh" "$EXT_ID"
}

print_next_steps() {
  cat <<EOF

Recent Cycle installed to: ${EXT_DIR}

Finish setup in Chrome (one time only):
  1. Open  chrome://extensions
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked" and select this folder:
       ${EXT_DIR}
  4. Open  chrome://extensions/shortcuts  and set the forward shortcut to Global.

Registered companion id: $(extension_id_for_path "$EXT_DIR" 2>/dev/null || printf 'n/a')
EOF
}

while (( $# )); do
  case "$1" in
    --clean)            MODE="clean"; shift ;;
    --companion-only)   MODE="companion-only"; shift ;;
    --no-companion)     INSTALL_COMPANION=0; shift ;;
    --extension-id=*)   EXT_ID="${1#*=}"; shift ;;
    --extension-id)     EXT_ID="${2:?missing value for --extension-id}"; shift 2 ;;
    --version=*)        VERSION="${1#*=}"; shift ;;
    --version)          VERSION="${2:?missing value for --version}"; shift 2 ;;
    --package-url=*)    PACKAGE_URL="${1#*=}"; shift ;;
    --package-url)      PACKAGE_URL="${2:?missing value for --package-url}"; shift 2 ;;
    -h|--help)          usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [[ "$MODE" == "companion-only" ]]; then
  [[ -n "$EXT_ID" ]] || EXT_ID="$(resolve_extension_id 2>/dev/null || true)"
  [[ -n "$EXT_ID" ]] || die "could not resolve the extension id; rerun with --companion-only --extension-id <id>"
  [[ "$(uname -s)" == "Darwin" ]] || die "the companion is macOS-only (current: $(uname -s))"
  log "Companion-only mode for extension id: $EXT_ID"
  if [[ -f "$EXT_DIR/native/install.sh" ]]; then
    log "Using native sources already installed at: $EXT_DIR/native"
    zsh "$EXT_DIR/native/install.sh" "$EXT_ID"
  else
    PACKAGE_URL="$(resolve_package_url)"
    ZIPFILE="$(fetch_package "$PACKAGE_URL")"
    UNPACK="$(mktemp -d)"
    command -v unzip >/dev/null 2>&1 || die "unzip is required"
    unzip -q -o "$ZIPFILE" -d "$UNPACK"
    SRC="$(single_extension_dir "$UNPACK")"
    zsh "$SRC/native/install.sh" "$EXT_ID"
    rm -f "$ZIPFILE"; rm -rf "$UNPACK"
  fi
  cat <<EOF

The Recent Cycle macOS companion is installed for extension id: $EXT_ID

Reload the extension in chrome://extensions, then allow Accessibility access
when macOS asks. If this id does not match the extension you have loaded,
reinstall with:  --companion-only --extension-id <your-32-char-id>
EOF
  exit 0
fi

PACKAGE_URL="$(resolve_package_url)"

if [[ "$MODE" == "clean" ]]; then
  log "Removing previous install at: $APP_DIR"
  rm -rf "$APP_DIR"
fi

ZIPFILE="$(fetch_package "$PACKAGE_URL")"
UNPACK="$(mktemp -d)"
command -v unzip >/dev/null 2>&1 || die "unzip is required"
unzip -q -o "$ZIPFILE" -d "$UNPACK"
SRC="$(single_extension_dir "$UNPACK")"

rm -rf "$EXT_DIR"
mkdir -p "$APP_DIR"
cp -R "$SRC" "$EXT_DIR"
rm -f "$ZIPFILE"; rm -rf "$UNPACK"

log "Installed the Recent Cycle extension to: $EXT_DIR"

if [[ "$INSTALL_COMPANION" -eq 1 ]]; then
  install_companion "$EXT_DIR/native" "$EXT_ID"
else
  warn "Skipped the native companion (--no-companion); browser-only mode."
fi

print_next_steps