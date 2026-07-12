#!/usr/bin/env bash
# Local E2E checklist + readiness checks — Claude Tag on Cloudflare.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EDGE="$(cd "$(dirname "$0")/.." && pwd)"

echo "== OpenTag E2E (local) =="
echo

fail=0
warn() { echo "WARNING: $*"; }
die() { echo "ERROR: $*"; fail=1; }

echo "Prereqs:"
if [[ ! -d "$ROOT/../CopilotKit/packages/channels" ]]; then
  die "Sibling CopilotKit missing at ../CopilotKit — see edge/README.md"
else
  echo "  ✓ Sibling CopilotKit checkout present"
fi

if [[ ! -f "$EDGE/.dev.vars" ]]; then
  die "edge/.dev.vars missing — cp edge/.dev.vars.example edge/.dev.vars and fill Slack + AGENT_URL"
else
  echo "  ✓ edge/.dev.vars present"
  # shellcheck disable=SC1091
  set -a; source "$EDGE/.dev.vars" 2>/dev/null || true; set +a
  [[ -n "${SLACK_BOT_TOKEN:-}" && "$SLACK_BOT_TOKEN" != xoxb-... ]] || warn "SLACK_BOT_TOKEN looks unset"
  [[ -n "${SLACK_SIGNING_SECRET:-}" && "$SLACK_SIGNING_SECRET" != ... ]] || warn "SLACK_SIGNING_SECRET looks unset"
  [[ -n "${AGENT_URL:-}" ]] || warn "AGENT_URL unset (default wrangler localhost:8200)"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  warn "Root .env missing — pnpm runtime needs OPENAI_API_KEY (+ optional LINEAR/Notion)"
else
  echo "  ✓ Root .env present"
fi

echo
echo "Terminal A — agent runtime (must be reachable at AGENT_URL):"
echo "  cd $ROOT && pnpm runtime"
echo "  # Production: host this publicly and set AGENT_URL via wrangler secret/var"
echo "  # (Workers cannot reach http://localhost on your laptop.)"
echo
echo "Terminal B — bot Worker:"
echo "  cd $EDGE && npm run dev"
echo
echo "Terminal C — tunnel:"
echo "  cloudflared tunnel --url http://localhost:8787"
echo "  # Point Slack Events / Commands / Interactions at the tunnel host"
echo "  # Re-install slack-app-manifest.yaml (includes message.channels)"
echo
echo "Optional research Worker:"
echo "  # Merge .dev.vars.research.example into .dev.vars"
echo "  cd $EDGE && npm run dev:research"
echo "  # Then: /research <topic> or @bot research: <topic>"
echo
echo "Smoke checklist:"
echo "  1. @mention the bot → AG-UI reply in thread"
echo "  2. Reply in the same channel thread without @mention → bot continues"
echo "  3. Ask to list Linear issues → issue_list Block Kit card"
echo "  4. Ask to create an issue → confirm_write → Approve (retry after Worker restart)"
echo "  5. Restrict a tool via POST /admin/bundle → denied tool message"
echo "  6. /research in a thread → orchestrator delivery posts back"
echo "  7. say 'remember: …' → knowledge saved; ask about it later"
echo

# Optional live probes if services are already up
if curl -sf --max-time 2 "${AGENT_URL:-http://localhost:8200}/api/copilotkit/agent/triage/run" -X OPTIONS >/dev/null 2>&1 \
  || curl -sf --max-time 2 "http://localhost:8200/" >/dev/null 2>&1; then
  echo "  ✓ Agent runtime appears reachable on :8200"
else
  warn "Agent runtime not reachable yet (start Terminal A)"
fi

if curl -sf --max-time 2 "http://localhost:8787/health" >/dev/null 2>&1; then
  echo "  ✓ Bot Worker /health ok on :8787"
  curl -s "http://localhost:8787/health" | head -c 200; echo
else
  warn "Bot Worker not reachable yet (start Terminal B)"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "Ready — run the smoke checklist above."
exit 0
