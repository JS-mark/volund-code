#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:?usage: build.sh SOURCE_DIR OUTPUT}
output=${2:?usage: build.sh SOURCE_DIR OUTPUT}

export SOURCE_DATE_EPOCH=1776902400
cc -std=gnu11 -O2 -D_GNU_SOURCE -fno-ident \
  -ffile-prefix-map="$source_dir"=/usr/src/bubblewrap \
  -Wl,--build-id=none \
  -include "$source_dir/config.h" \
  "$source_dir/bubblewrap.c" \
  "$source_dir/bind-mount.c" \
  "$source_dir/network.c" \
  "$source_dir/utils.c" \
  -lcap -o "$output"
strip --strip-unneeded --remove-section=.comment "$output"
