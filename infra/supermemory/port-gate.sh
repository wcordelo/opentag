#!/bin/sh
set -eu

application_port="${SUPERMEMORY_APPLICATION_PORT:-6768}"
r2_ready_file="${SUPERMEMORY_R2_READY_FILE:-/run/opentag-supermemory-r2-ready}"
provider_ready_file="${SUPERMEMORY_PROVIDER_READY_FILE:-/run/opentag-supermemory-provider-ready}"

carriage_return="$(printf '\r')"
content_length="0"
request_line=""
connection_header_seen="0"
request_file="$(mktemp)"
cleanup() {
  rm -f "$request_file"
}
trap cleanup EXIT
while IFS= read -r line; do
  line="${line%"$carriage_return"}"
  if [ -z "$request_line" ]; then
    request_line="$line"
  fi
  if [ -z "$line" ]; then
    if [ "$connection_header_seen" != "1" ]; then
      printf 'Connection: close\r\n' >> "$request_file"
    fi
    printf '\r\n' >> "$request_file"
    break
  fi
  header_name="$(printf '%s' "$line" | cut -d ':' -f 1 | tr '[:upper:]' '[:lower:]')"
  case "$header_name" in
    connection)
      printf 'Connection: close\r\n' >> "$request_file"
      connection_header_seen="1"
      ;;
    content-length)
      printf '%s\r\n' "$line" >> "$request_file"
      content_length="$(printf '%s' "$line" | cut -d ':' -f 2- | tr -d '[:space:]')"
      ;;
    *)
      printf '%s\r\n' "$line" >> "$request_file"
      ;;
  esac
done

case "$content_length" in
  ''|*[!0-9]*) content_length="0" ;;
esac
if [ "$content_length" -gt 0 ]; then
  dd bs=1 count="$content_length" >> "$request_file" 2>/dev/null || true
fi

case "$request_line" in
  GET\ /health\ HTTP/*)
    printf 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    exit 0
    ;;
  GET\ /ready\ HTTP/*)
    if [ -f "$provider_ready_file" ]; then
      printf 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    else
      printf 'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    fi
    exit 0
    ;;
esac

if [ -f "$provider_ready_file" ]; then
  /usr/bin/socat - "TCP:127.0.0.1:${application_port},shut-none" < "$request_file"
  exit $?
fi

printf 'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
