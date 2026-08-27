#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
resource_dir="$repo_root/crates/volund-sandbox/resources/bwrap"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

for entry in linux/amd64:x86_64-unknown-linux-gnu linux/arm64:aarch64-unknown-linux-gnu; do
  platform=${entry%%:*}
  target=${entry##*:}
  mkdir -p "$tmp_dir/$target"
  image="volund-bwrap-build-${target}"
  docker build --platform "$platform" -t "$image" "$resource_dir"
  container=$(docker create "$image")
  docker cp "$container:/bwrap" "$tmp_dir/$target/bwrap"
  docker rm "$container" >/dev/null
  sha256=$(shasum -a 256 "$tmp_dir/$target/bwrap" | awk '{print $1}')
  printf '%s  %s\n' "$sha256" "$target/bwrap"
  if [[ ${1:-} == --check ]]; then
    cmp "$tmp_dir/$target/bwrap" "$resource_dir/$target/bwrap"
  else
    install -m 0755 "$tmp_dir/$target/bwrap" "$resource_dir/$target/bwrap"
  fi
done
