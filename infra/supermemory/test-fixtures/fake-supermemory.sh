#!/bin/sh
set -eu

printf 'generated sm_fake_generated_key_123456\n'
printf 'provider sk-fake_provider_secret_123456\n' >&2
printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}" >&2
printf 'argv:%s\n' "$*"

if [ "${1:-}" = "--wait" ]; then
  trap 'exit 42' TERM INT HUP
  while :; do sleep 1; done
fi

exit "${FAKE_EXIT_CODE:-17}"
