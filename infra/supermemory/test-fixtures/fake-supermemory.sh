#!/bin/sh
set -eu

data_dir="${SUPERMEMORY_DATA_DIR:?SUPERMEMORY_DATA_DIR is required}"
mkdir -p "$data_dir"
if [ ! -s "$data_dir/api-key" ]; then
  printf '%s\n' 'sm_fake_bootstrap_key_987654' > "$data_dir/api-key"
  chmod 600 "$data_dir/api-key"
fi
if [ "${SUPERMEMORY_API_KEY:-}" != "sm_fake_bootstrap_key_987654" ]; then
  exit 23
fi

printf 'generated sm_fake_generated_key_123456\n'
printf 'provider sk-fake_provider_secret_123456\n' >&2
printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}" >&2
printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}" >&2
printf 'PORT=%s\n' "${PORT:-}" >&2
printf 'argv:%s\n' "$*"

if [ "${1:-}" = "--wait" ]; then
  trap 'exit 42' TERM INT HUP
  while :; do sleep 1; done
fi

exit "${FAKE_EXIT_CODE:-17}"
