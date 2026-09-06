#!/usr/bin/env bash
# volund standalone installer (macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JS-mark/volund-code/main/scripts/install/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/JS-mark/volund-code/main/scripts/install/install.sh | bash -s -- v0.1.2
#   VOLUND_INSTALL_VERSION=v0.1.2 ./install.sh
#
# Layout:
#   ~/.volund/lib/<version>/   extracted standalone archive (volund + native/ + plugins/)
#   ~/.volund/bin/volund       versioned launcher shim
#
# native/ and plugins/ must stay next to the executable: the standalone runtime
# resolves them from dirname(execPath) (packages/native-bridge/src/resolver.ts),
# so installing the archive as a directory plus a shim is deliberate.
#
# Env overrides:
#   VOLUND_INSTALL_VERSION           version to install (default: latest release)
#   VOLUND_HOME                      install root (default: ~/.volund)
#   VOLUND_RELEASE_BASE              release base URL (default: GitHub Releases)
#   VOLUND_INSTALL_REPO              repository slug (default: JS-mark/volund-code)
#   VOLUND_INSTALL_NO_MODIFY_PATH=1  do not edit shell rc files
set -euo pipefail

REPOSITORY="${VOLUND_INSTALL_REPO:-JS-mark/volund-code}"
RELEASE_BASE="${VOLUND_RELEASE_BASE:-https://github.com/${REPOSITORY}/releases}"
VOLUND_HOME="${VOLUND_HOME:-${HOME:?HOME is not set}/.volund}"
VERSION_ARG="${1:-${VOLUND_INSTALL_VERSION:-}}"

BAR_BLOCKS=50

info() { printf '%s\n' "$*" >&2; }
die() {
  if [ -t 2 ]; then printf '\033[31merror:\033[0m %s\n' "$*" >&2
  else printf 'error: %s\n' "$*" >&2; fi
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

fetch() { # <url> <output-file>
  if have curl; then
    curl -fsSL --retry 3 --retry-delay 1 -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required to download volund"
  fi
}

detect_target() {
  local os arch libc
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      die "this installer targets macOS and Linux; on Windows install @volund/cli from npm or use WSL"
      ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  # Target triple convention matches build-standalone.mjs: libc only on linux
  # (darwin-arm64 / linux-x64-gnu / win32-x64-msvc).
  if [ "$os" = linux ]; then
    libc=gnu
    if ldd --version 2>&1 | grep -qi musl; then
      libc=musl
    fi
    printf '%s-%s-%s\n' "$os" "$arch" "$libc"
  else
    printf '%s-%s\n' "$os" "$arch"
  fi
}

# The release manifest is pretty-printed by scripts/release/generate-release-manifest.mjs:
# top-level "version", and per-artifact blocks keyed on "archiveName" followed by
# "sha256"/"size". Parsed with awk so the installer has no jq/node dependency.
manifest_top_level() { # <file> <key>
  awk -v key="$2" 'index($0, "\"" key "\":") {
    sub(/^.*"[^"]*": ?/, ""); sub(/,?$/, ""); gsub(/^"|"$/, ""); print; exit
  }' "$1"
}

manifest_artifact_field() { # <file> <archive-name> <key: sha256|size>
  awk -v archive="$2" -v key="$3" '
    index($0, "\"archiveName\": \"" archive "\"") { found = 1; next }
    found && index($0, "\"" key "\":") {
      sub(/^.*"[^"]*": ?/, ""); sub(/,?$/, ""); gsub(/^"|"$/, ""); print; exit
    }
  ' "$1"
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify the download"
  fi
}

# 样式对齐 mimocode 安装器：顶格橙色实心块 ▮，未满一格画一个点，右侧百分比。
progress_bar() { # <current-bytes> <total-bytes>
  local current=$1 total=$2 pct units full dot bar i color reset
  [ "$total" -gt 0 ] || return 0
  # 千分位块单位：整块画 ▮，余数画点，显示 floor 百分比（对齐截图 98% 带尾点的观感）。
  units=$((current * BAR_BLOCKS * 1000 / total))
  full=$((units / 1000))
  dot=''
  if [ "$((units - full * 1000))" -gt 0 ]; then dot='.'; fi
  pct=$((units * 100 / (BAR_BLOCKS * 1000)))
  bar=''
  i=0
  while [ "$i" -lt "$full" ]; do
    bar="${bar}▮"
    i=$((i + 1))
  done
  color=''
  reset=''
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    color=$'\033[38;5;208m'
    reset=$'\033[0m\033[K'
  fi
  printf '\r%s%s%s  %3d%%%s' "$color" "$bar" "$dot" "$pct" "$reset" >&2
}

download_with_progress() { # <url> <output-file> <expected-bytes>
  local url=$1 out=$2 expected=${3:-0} pid current
  rm -f "$out"
  if [ "$expected" -gt 0 ] 2>/dev/null; then
    if have curl; then
      curl -fsSL --retry 3 --retry-delay 1 -sS -o "$out" "$url" &
    else
      wget -q -O "$out" "$url" &
    fi
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      # A finished child is a zombie that kill -0 still accepts, so exit the
      # poll loop on the Z process state instead.
      if ps -o stat= -p "$pid" 2>/dev/null | grep -q '^Z'; then break; fi
      current=0
      if [ -f "$out" ]; then current=$(wc -c <"$out" | tr -d ' '); fi
      progress_bar "$current" "$expected"
      sleep 0.1 2>/dev/null || sleep 1
    done
    if ! wait "$pid"; then
      printf '\n' >&2
      rm -f "$out"
      die "download failed: $url"
    fi
    progress_bar "$expected" "$expected"
    printf '\n' >&2
  else
    info '  downloading (size unknown)...'
    fetch "$url" "$out"
  fi
}

resolve_version() {
  local manifest tag
  if [ -n "$VERSION_ARG" ]; then
    VERSION="${VERSION_ARG#v}"
    tag="v${VERSION}"
    manifest_url="${RELEASE_BASE}/download/${tag}/release-manifest.json"
  else
    manifest_url="${RELEASE_BASE}/latest/download/release-manifest.json"
  fi
  manifest="$STAGE/release-manifest.json"
  fetch "$manifest_url" "$manifest" ||
    die "could not fetch $manifest_url — check your connection or the releases page at https://github.com/${REPOSITORY}/releases"
  [ -s "$manifest" ] || die "release manifest at $manifest_url is empty"
  if [ -z "$VERSION_ARG" ]; then
    VERSION=$(manifest_top_level "$manifest" version)
    [ -n "$VERSION" ] || die "release manifest has no version field; install a pinned version with VOLUND_INSTALL_VERSION=<v>"
  fi
  info "Installing volund version: ${VERSION}"
}

STAGE=""
cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

main() {
  local target archive_name archive_path expected_size expected_sha actual_sha
  target=$(detect_target)
  info "Detected platform: ${target}"

  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/volund-install.XXXXXX")

  resolve_version

  archive_name="volund-standalone-${target}.tar.gz"
  archive_path="$STAGE/$archive_name"
  expected_size=$(manifest_artifact_field "$STAGE/release-manifest.json" "$archive_name" size)
  expected_sha=$(manifest_artifact_field "$STAGE/release-manifest.json" "$archive_name" sha256)
  [ -n "$expected_sha" ] ||
    die "release ${VERSION} has no archive for ${target}; supported targets are listed in release-manifest.json"

  download_with_progress "${RELEASE_BASE}/download/v${VERSION}/${archive_name}" "$archive_path" "$expected_size"

  actual_sha=$(sha256_of "$archive_path")
  if [ "$actual_sha" != "$expected_sha" ]; then
    rm -f "$archive_path"
    die "checksum mismatch for ${archive_name}: expected ${expected_sha}, got ${actual_sha}"
  fi

  install_release
  print_summary
}

install_release() {
  local lib_root final existing shim rc_file
  lib_root="${VOLUND_HOME}/lib"
  final="$lib_root/${VERSION}"

  mkdir -p "$STAGE/extracted"
  tar -xzf "$STAGE/$archive_name" -C "$STAGE/extracted"
  [ -f "$STAGE/extracted/volund" ] || die "archive ${archive_name} does not contain a volund executable"
  chmod 755 "$STAGE/extracted/volund"

  mkdir -p "$lib_root" "${VOLUND_HOME}/bin"
  rm -rf "$final"
  mv "$STAGE/extracted" "$final"

  if ! "$final/volund" --version >/dev/null 2>&1; then
    rm -rf "$final"
    die "the volund ${VERSION} binary for ${target} failed to start on this machine"
  fi

  for existing in "$lib_root"/*; do
    [ -d "$existing" ] || continue
    [ "${existing##*/}" = "$VERSION" ] && continue
    rm -rf "$existing"
  done

  shim="${VOLUND_HOME}/bin/volund"
  cat >"$shim" <<EOF
#!/bin/sh
# volund launcher generated by the volund installer
exec "${final}/volund" "\$@"
EOF
  chmod 755 "$shim"

  if [ "${VOLUND_INSTALL_NO_MODIFY_PATH:-0}" = 1 ]; then return 0; fi
  case ":$PATH:" in
    *":${VOLUND_HOME}/bin:"*) return 0 ;;
  esac
  case "${SHELL:-}" in
    */zsh) rc_file="${HOME}/.zshrc" ;;
    */bash)
      rc_file="${HOME}/.bashrc"
      if [ "$(uname -s)" = Darwin ] && [ -f "${HOME}/.bash_profile" ]; then
        rc_file="${HOME}/.bash_profile"
      fi
      ;;
    */fish)
      info "Add volund to your PATH manually (fish syntax):"
      info "  fish_add_path ${VOLUND_HOME}/bin"
      return 0
      ;;
    *) rc_file="${HOME}/.profile" ;;
  esac
  if grep -qs "${VOLUND_HOME}/bin" "$rc_file"; then return 0; fi
  {
    printf '\n# volund\n'
    printf 'export PATH="%s/bin:$PATH"\n' "$VOLUND_HOME"
  } >>"$rc_file"
  RC_UPDATED="$rc_file"
}

print_summary() {
  local note=''
  if [ -n "${RC_UPDATED:-}" ]; then
    note=" Open a new shell or run: source ${RC_UPDATED}"
  fi
  if [ -t 2 ]; then
    printf '\033[32mvolund %s installed to %s\033[0m.%s\n' "$VERSION" "$VOLUND_HOME" "$note" >&2
  else
    info "volund ${VERSION} installed to ${VOLUND_HOME}.${note}"
  fi
  info "Run 'volund --help' to get started."
}

main "$@"
