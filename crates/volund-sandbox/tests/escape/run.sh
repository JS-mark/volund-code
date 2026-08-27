#!/usr/bin/env bash
set -euo pipefail
sandbox_bin=${1:?volund-sandbox binary required}
work_dir=$(mktemp -d)
escape_root=$(mktemp -d)
trap 'rm -rf "$work_dir" "$escape_root"' EXIT
baseline=$(printf '{"command":"printf allowed > %s/allowed","cwd":"%s","permissions":{"fs":{"read":["%s/**"],"write":["%s/**"]},"net":false,"env":{"read":[]}},"env":{}}' "$work_dir" "$work_dir" "$work_dir" "$work_dir")
baseline_result=$("$sandbox_bin" exec <<<"$baseline")
if [[ $baseline_result != *'"exit_code":0'* ]] || [[ ! -f $work_dir/allowed ]]; then
  printf 'sandbox baseline failed: %s\n' "$baseline_result" >&2
  exit 1
fi
test "$(cat "$work_dir/allowed")" = allowed

escape=$(printf '{"command":"printf blocked > %s/blocked","cwd":"%s","permissions":{"fs":{"read":["%s/**"],"write":["%s/**"]},"net":false,"env":{"read":[]}},"env":{}}' "$escape_root" "$work_dir" "$work_dir" "$work_dir")
escape_result=$("$sandbox_bin" exec <<<"$escape")
if [[ $escape_result == *'"exit_code":0'* ]]; then
  printf 'escape unexpectedly succeeded: %s\n' "$escape_result" >&2
  exit 1
fi
test ! -e "$escape_root/blocked"
