#!/usr/bin/env bash
# Local loop smoke (no public tunnel): signed Events API → Worker → AGENT_URL → Slack.
# Requires: edge/.dev.vars, pnpm runtime (:8200), npm run dev (:8787), bot in a channel.
set -euo pipefail
EDGE="$(cd "$(dirname "$0")/.." && pwd)"
export EDGE_DIR="$EDGE"

curl -sf "http://localhost:8787/health" >/dev/null || {
  echo "Bot Worker not up on :8787 — cd edge && npm run dev"
  exit 1
}
if ! curl -sf -o /dev/null -X OPTIONS "http://localhost:8200/api/copilotkit/agent/triage/run" 2>/dev/null; then
  echo "Agent runtime not up on :8200 — cd repo root && pnpm runtime"
  exit 1
fi

python3 - <<'PY'
import hmac, hashlib, json, time, urllib.request, os
from pathlib import Path

vars = {}
for line in (Path(os.environ["EDGE_DIR"]) / ".dev.vars").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        vars[k] = v

token = vars["SLACK_BOT_TOKEN"]
secret = vars["SLACK_SIGNING_SECRET"]

def slack(method, payload=None, query=""):
    url = f"https://slack.com/api/{method}{query}"
    if method == "auth.test":
        data = b"{}"
        method_http = "POST"
    elif payload is not None:
        data = json.dumps(payload).encode()
        method_http = "POST"
    else:
        data = None
        method_http = "GET"
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method_http,
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

auth = slack("auth.test")
assert auth.get("ok"), auth
bot_id = auth["user_id"]
team_id = auth["team_id"]

listing = slack(
    "conversations.list",
    query="?types=public_channel,private_channel&limit=50&exclude_archived=true",
)
assert listing.get("ok"), listing
channel = next((c for c in listing["channels"] if c.get("is_member")), None)
assert channel, "bot is not a member of any channel — /invite it"
channel_id = channel["id"]

seed = slack("chat.postMessage", {"channel": channel_id, "text": f"E2E seed {int(time.time())}"})
assert seed.get("ok"), seed
parent_ts = seed["ts"]

msg_ts = f"{time.time():.6f}"
event_id = f"EvSmoke{int(time.time())}"
body = json.dumps(
    {
        "type": "event_callback",
        "team_id": team_id,
        "event_id": event_id,
        "event": {
            "type": "app_mention",
            "channel": channel_id,
            "user": bot_id,
            "text": f"<@{bot_id}> ping — reply with exactly one word: pong",
            "ts": msg_ts,
            "thread_ts": parent_ts,
        },
    }
)
ts = str(int(time.time()))
sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(
    "http://localhost:8787/slack/events",
    data=body.encode(),
    headers={
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=15) as r:
    print("ack", r.status, r.read().decode())

print(f"waiting for reply in #{channel.get('name')} thread {parent_ts} …")
deadline = time.time() + 45
found = None
while time.time() < deadline:
    time.sleep(3)
    replies = slack(
        "conversations.replies",
        query=f"?channel={channel_id}&ts={parent_ts}&limit=20",
    )
    if not replies.get("ok"):
        continue
    for m in replies.get("messages") or []:
        if m.get("ts") == parent_ts:
            continue
        text = (m.get("text") or "").strip().lower()
        if "pong" in text:
            found = m
            break
        if m.get("user") == bot_id and m.get("ts") != seed["ts"]:
            found = m
            break
    if found:
        break

if not found:
    print("FAIL: no bot reply within 45s")
    raise SystemExit(1)
print("PASS:", (found.get("text") or "")[:200])
PY
