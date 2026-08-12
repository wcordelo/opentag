#!/bin/sh
set -u

umask 077
data_dir="${SUPERMEMORY_DATA_DIR:-/var/lib/supermemory}"
binary="${SUPERMEMORY_BINARY:-/usr/local/bin/supermemory-server}"
application_port="${SUPERMEMORY_APPLICATION_PORT:-6768}"
export PORT="$application_port"
gate_pid=""
tigrisfs_pid=""
model_cache_mounted="0"
child_pid=""
redactor_pid=""
received_signal=""
r2_ready_file="${SUPERMEMORY_R2_READY_FILE:-/run/opentag-supermemory-r2-ready}"
provider_ready_file="${SUPERMEMORY_PROVIDER_READY_FILE:-/run/opentag-supermemory-provider-ready}"
gate_pid_file="/run/opentag-supermemory-r2-gate.pid"
tigrisfs_status_file="/run/opentag-supermemory-tigrisfs.status"
r2_cache_dir="/var/cache/supermemory/r2"
model_cache_dir="/var/cache/supermemory/models"

forward_signal() {
  received_signal=1
  if [ -n "$child_pid" ]; then kill -TERM "$child_pid" 2>/dev/null || true; fi
  if [ -n "$gate_pid" ]; then kill -TERM "$gate_pid" 2>/dev/null || true; fi
  if [ -n "$tigrisfs_pid" ]; then kill -TERM "$tigrisfs_pid" 2>/dev/null || true; fi
}

cleanup() {
  if [ -n "$child_pid" ]; then kill "$child_pid" 2>/dev/null || true; fi
  if [ -n "$redactor_pid" ]; then kill "$redactor_pid" 2>/dev/null || true; fi
  if [ -n "$gate_pid" ]; then kill "$gate_pid" 2>/dev/null || true; fi
  if [ -n "$tigrisfs_pid" ]; then
    if [ "$model_cache_mounted" = "1" ]; then
      fusermount3 -u "$data_dir/models" 2>/dev/null || umount -l "$data_dir/models" 2>/dev/null || true
    fi
    fusermount3 -u "$data_dir" 2>/dev/null || umount -l "$data_dir" 2>/dev/null || true
    kill "$tigrisfs_pid" 2>/dev/null || true
  fi
  rm -f "$r2_ready_file" "$provider_ready_file" "$gate_pid_file"
  if [ -n "${scratch:-}" ]; then rm -rf "$scratch"; fi
}

trap 'forward_signal' TERM INT HUP
trap cleanup EXIT

mkdir -p "$data_dir" || exit $?

if [ "${SUPERMEMORY_ALLOW_LOCAL_DISK:-}" != "true" ]; then
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ] ||
    [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET_NAME:-}" ]; then
    echo "supermemory R2 credentials are required" >&2
    exit 78
  fi
  case "$R2_ACCOUNT_ID" in
    *[!A-Za-z0-9_-]* ) echo "supermemory R2 account is invalid" >&2; exit 78 ;;
  esac
  case "$R2_BUCKET_NAME" in
    *[!A-Za-z0-9._-]* ) echo "supermemory R2 bucket is invalid" >&2; exit 78 ;;
  esac
  rm -f /etc/machine-id /var/lib/dbus/machine-id 2>/dev/null || true
  rm -f "$r2_ready_file" "$provider_ready_file" "$gate_pid_file" "$tigrisfs_status_file"
  SUPERMEMORY_APPLICATION_PORT="$application_port" \
  SUPERMEMORY_R2_READY_FILE="$r2_ready_file" \
  SUPERMEMORY_PROVIDER_READY_FILE="$provider_ready_file" \
    /usr/bin/socat TCP-LISTEN:6767,reuseaddr,fork EXEC:/usr/local/bin/supermemory-port-gate >/dev/null 2>&1 &
  gate_pid=$!
  printf '%s\n' "$gate_pid" > "$gate_pid_file"
  if ! command -v /usr/local/bin/tigrisfs >/dev/null 2>&1; then
    echo "supermemory tigrisfs is unavailable" >&2
    exit 70
  fi
  mkdir -p "$r2_cache_dir"
  /usr/local/bin/tigrisfs \
    --endpoint "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
    --cache "$r2_cache_dir" --fsync-on-close \
    -o allow_other --uid=999 --gid=999 -f "$R2_BUCKET_NAME" "$data_dir" >/dev/null 2>&1 &
  tigrisfs_pid=$!
  mounted="0"
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    if ! kill -0 "$tigrisfs_pid" 2>/dev/null; then
      wait "$tigrisfs_pid" 2>/dev/null
      tigrisfs_status=$?
      printf 'tigrisfs_exit_status=%s\\n' "$tigrisfs_status" > "$tigrisfs_status_file"
      echo "supermemory tigrisfs stopped before the mount was ready" >&2
      exit 70
    fi
    if mountpoint -q "$data_dir" 2>/dev/null; then
      mounted="1"
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$mounted" != "1" ]; then
    printf 'tigrisfs_mount_timeout=90\\n' > "$tigrisfs_status_file"
    echo "supermemory R2 mount did not become ready" >&2
    exit 70
  fi
  probe_file="$data_dir/.opentag-supermemory-r2-probe"
  if ! runuser -u supermemory -- sh -c 'printf %s opentag-r2-probe > "$1" && [ "$(cat "$1")" = opentag-r2-probe ] && rm -f "$1"' sh "$probe_file"; then
    echo "supermemory R2 read/write check failed" >&2
    exit 70
  fi
  rm -rf "$model_cache_dir" || exit $?
  mkdir -p "$model_cache_dir"
  chown -R 999:999 /var/cache/supermemory
  mkdir -p "$data_dir/models"
  if ! mount --bind "$model_cache_dir" "$data_dir/models"; then
    echo "supermemory local model cache mount failed" >&2
    exit 70
  fi
  model_cache_mounted="1"
  touch "$r2_ready_file"
fi

if [ "${SUPERMEMORY_ALLOW_LOCAL_DISK:-}" = "true" ]; then
  if [ "$(id -u)" -eq 0 ] && id supermemory >/dev/null 2>&1; then
    chown supermemory:supermemory "$data_dir" 2>/dev/null || true
  fi
  chmod 700 "$data_dir" 2>/dev/null || true
fi
if [ ! -w "$data_dir" ]; then
  echo "supermemory data directory is not writable" >&2
  exit 70
fi

provider_key_configured="false"
if [ -n "${OPENAI_API_KEY:-}" ]; then provider_key_configured="true"; fi
echo "supermemory provider configuration: key_configured=$provider_key_configured base_url=${OPENAI_BASE_URL:-default} model=${OPENAI_MODEL:-default}"
if [ "$provider_key_configured" != "true" ]; then
  echo "supermemory model provider key is required" >&2
  exit 78
fi

if [ -r "$data_dir/api-key" ]; then
  SUPERMEMORY_API_KEY="$(tr -d '\r\n' < "$data_dir/api-key")"
  export SUPERMEMORY_API_KEY
fi

scratch="$(mktemp -d)" || exit $?
fifo="$scratch/server.log"
mkfifo "$fifo" || exit $?

redact_stream() {
  REDACT_EXACT_SECRETS="${SUPERMEMORY_API_KEY:-}$(printf '\036')${OPENAI_API_KEY:-}$(printf '\036')${ANTHROPIC_API_KEY:-}$(printf '\036')${GEMINI_API_KEY:-}$(printf '\036')${GROQ_API_KEY:-}$(printf '\036')${WORKERS_AI_API_KEY:-}$(printf '\036')${SUPERMEMORY_SERVICE_AUTH_TOKEN:-}$(printf '\036')${AWS_ACCESS_KEY_ID:-}$(printf '\036')${AWS_SECRET_ACCESS_KEY:-}$(printf '\036')${R2_ACCESS_KEY_ID:-}$(printf '\036')${R2_SECRET_ACCESS_KEY:-}" \
    perl -pe '
      BEGIN {
        select STDOUT;
        $| = 1;
        @secrets = grep { length($_) } split(/\036/, $ENV{REDACT_EXACT_SECRETS} // "");
        @secrets = sort { length($b) <=> length($a) } @secrets;
      }
      for my $secret (@secrets) { s/\Q$secret\E/[REDACTED]/g; }
      s/\bsm_[A-Za-z0-9_-]+/[REDACTED]/g;
      s/\bsk-[A-Za-z0-9_-]+/[REDACTED]/g;
      s/\bBearer\s+[A-Za-z0-9._~-]+/Bearer [REDACTED]/g;
      s/\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|SUPERMEMORY_API_KEY|SUPERMEMORY_SERVICE_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|WORKERS_AI_API_KEY)=[^\s]+/$1=[REDACTED]/g;
    '
}

run_server() {
  if [ "$(id -u)" -eq 0 ] && id supermemory >/dev/null 2>&1; then
    exec env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u R2_ACCESS_KEY_ID \
      -u R2_SECRET_ACCESS_KEY -u R2_ACCOUNT_ID -u R2_BUCKET_NAME \
      -u SUPERMEMORY_SERVICE_AUTH_TOKEN runuser -u supermemory -- "$binary" "$@"
  fi
  exec env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u R2_ACCESS_KEY_ID \
    -u R2_SECRET_ACCESS_KEY -u R2_ACCOUNT_ID -u R2_BUCKET_NAME \
    -u SUPERMEMORY_SERVICE_AUTH_TOKEN "$binary" "$@"
}

redact_stream < "$fifo" &
redactor_pid=$!
run_server "$@" > "$fifo" 2>&1 &
child_pid=$!
if [ -n "$received_signal" ]; then forward_signal; fi

if [ "${SUPERMEMORY_ALLOW_LOCAL_DISK:-}" != "true" ]; then
  provider_ready="0"
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      wait "$child_pid"
      child_status=$?
      exit "$child_status"
    fi
    status="$(curl -sS --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${application_port}/v3/openapi" 2>/dev/null || printf '000')"
    case "$status" in
      2??)
        touch "$provider_ready_file"
        provider_ready="1"
        break
        ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$provider_ready" != "1" ]; then
    echo "supermemory application did not become ready" >&2
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    exit 70
  fi
fi

while :; do
  wait "$child_pid"
  child_status=$?
  if kill -0 "$child_pid" 2>/dev/null; then continue; fi
  break
done
wait "$redactor_pid"
exit "$child_status"
