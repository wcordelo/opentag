#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: $0 <agent-pubkey-hex>" >&2
  echo "agent pubkey is required (no default)." >&2
  echo "live M1 signer: 292a282b30fd3fbe7cac2a956a632273ce4bb46aef8bc822dc9167e7d985ca75" >&2
  exit 1
fi

AGENT_PUBKEY="$1"
if [[ ! "${AGENT_PUBKEY}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "agent pubkey must be 64-char hex" >&2
  exit 1
fi
AGENT_PUBKEY="$(printf '%s' "${AGENT_PUBKEY}" | tr 'A-F' 'a-f')"

printf 'paste nsec then Enter (hidden): ' >&2
stty -echo
trap 'stty echo' EXIT
IFS= read -r NSEC
stty echo
trap - EXIT
printf '\n' >&2

if [[ -z "${NSEC}" ]]; then
  echo "empty nsec" >&2
  exit 1
fi

OWNER_SECRET="$(python3 -c '
import sys
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk
def hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]
def decode(bech):
    bech = bech.strip().lower()
    pos = bech.rfind("1")
    hrp, data = bech[:pos], [CHARSET.find(c) for c in bech[pos + 1:]]
    if any(d < 0 for d in data) or polymod(hrp_expand(hrp) + data) != 1:
        raise SystemExit("bad nsec")
    return hrp, data[:-6]
def convertbits(data, frombits, tobits):
    acc = bits = 0
    out = []
    maxv = (1 << tobits) - 1
    for v in data:
        acc = (acc << frombits) | v
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            out.append((acc >> bits) & maxv)
    return out
nsec = sys.argv[1]
hrp, data = decode(nsec)
if hrp != "nsec":
    raise SystemExit("expected nsec, got " + hrp)
raw = bytes(convertbits(data, 5, 8))
if len(raw) != 32:
    raise SystemExit("expected 32 bytes, got %d" % len(raw))
print(raw.hex())
' "${NSEC}")"
unset NSEC

if [[ ${#OWNER_SECRET} -ne 64 ]]; then
  echo "convert failed; got len ${#OWNER_SECRET}" >&2
  exit 1
fi

TAG="$(OWNER_SECRET="${OWNER_SECRET}" node scripts/mint-nip-oa-auth-tag.mjs "${AGENT_PUBKEY}" "")"
unset OWNER_SECRET

case "${TAG}" in
  '["auth",'*) ;;
  *)
    echo "mint failed; refusing wrangler put" >&2
    exit 1
    ;;
esac

printf '%s' "${TAG}" | npx wrangler secret put BUZZ_OPEN_TAG_AUTH_TAG --config wrangler.bot.toml
echo "ok: AUTH_TAG put (prefix $(printf '%s' "${TAG}" | head -c 20)...)" >&2
