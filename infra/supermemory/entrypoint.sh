#!/bin/sh
# Do not remove the redactor: Local's first boot emits a generated sm_ bearer
# key before an operator can retrieve it from the mounted volume.
set -u

umask 077
data_dir="${SUPERMEMORY_DATA_DIR:-/var/lib/supermemory}"
binary="${SUPERMEMORY_BINARY:-/usr/local/bin/supermemory-server}"

mkdir -p "$data_dir" || exit $?
# Railway volumes are often root-owned. Prefer mode 0700 when permitted; do not
# crash-loop when chmod is denied — fall through to the writable check instead.
if ! chmod 700 "$data_dir" 2>/dev/null; then
  echo "supermemory: chmod on data dir not permitted (common on Railway volumes); continuing if writable" >&2
fi
if [ ! -w "$data_dir" ]; then
  echo "supermemory data directory is not writable" >&2
  echo "supermemory: on Railway, set RAILWAY_RUN_UID=0 for root-owned volume mounts" >&2
  exit 70
fi

scratch="$(mktemp -d)" || exit $?
fifo="$scratch/server.log"
mkfifo "$fifo" || exit $?
child_pid=""
received_signal=""

cleanup() {
  rm -rf "$scratch"
}

forward_signal() {
  received_signal=1
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}

# The exact configured secrets are redacted without putting them in argv. The
# pattern replacements cover generated Local keys and common provider/bearer
# values from the first byte written by the child process.
redact_stream() {
  REDACT_EXACT_SECRETS="${SUPERMEMORY_API_KEY:-}$(printf '\036')${OPENAI_API_KEY:-}" \
    perl -pe '
      BEGIN {
        @secrets = grep { length($_) } split(/\036/, $ENV{REDACT_EXACT_SECRETS} // "");
        @secrets = sort { length($b) <=> length($a) } @secrets;
      }
      for my $secret (@secrets) { s/\Q$secret\E/[REDACTED]/g; }
      s/\bsm_[A-Za-z0-9_-]+/[REDACTED]/g;
      s/\bsk-[A-Za-z0-9_-]+/[REDACTED]/g;
      s/\bBearer\s+[A-Za-z0-9._~-]+/Bearer [REDACTED]/g;
      s/\b(OPENAI_API_KEY|SUPERMEMORY_API_KEY)=[^\s]+/$1=[REDACTED]/g;
    '
}

trap cleanup EXIT
trap 'forward_signal' TERM INT HUP
redact_stream < "$fifo" &
redactor_pid=$!
"$binary" "$@" > "$fifo" 2>&1 &
child_pid=$!

# A trapped signal interrupts wait on some shells. Keep waiting until the
# child is reaped so its own exit status, rather than a redactor/pipeline
# status, is returned to tini/Railway.
while :; do
  wait "$child_pid"
  child_status=$?
  if kill -0 "$child_pid" 2>/dev/null; then
    continue
  fi
  break
done
wait "$redactor_pid"
exit "$child_status"
