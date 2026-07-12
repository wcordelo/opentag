#!/usr/bin/env bash
# Local E2E checklist — Claude Tag on Cloudflare.
# Does not deploy; prints the process set to run manually.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== OpenTag E2E (local) =="
echo
echo "Prereqs:"
echo "  1. Sibling CopilotKit channels packages built (see edge/README.md)"
echo "  2. edge/.dev.vars from .dev.vars.example (Slack + AGENT_URL + secrets)"
echo "  3. Root .env with OPENAI_API_KEY (for pnpm runtime)"
echo "  4. Slack app Request URLs → tunneled Worker (events/commands/interactions)"
echo
echo "Terminal A — agent:"
echo "  cd $ROOT && pnpm runtime"
echo
echo "Terminal B — bot Worker:"
echo "  cd $ROOT/edge && npm run dev"
echo
echo "Terminal C — tunnel (example):"
echo "  cloudflared tunnel --url http://localhost:8787"
echo "  # Point Slack manifest URLs at the tunnel host"
echo
echo "Optional research:"
echo "  # Merge research secrets into edge/.dev.vars (see .dev.vars.research.example)"
echo "  cd $ROOT/edge && npm run dev:research   # port from wrangler.research.toml"
echo "  # Then: /research <topic> or @bot research: <topic>"
echo
echo "Smoke:"
echo "  1. @mention the bot → AG-UI reply in thread"
echo "  2. Ask confirm_write flow → Approve after restart still has action:* in DO"
echo "  3. Restrict bundle tools via /admin/bundle → denied tool message"
echo "  4. /research in a thread → orchestrator delivery posts back"
echo
if [[ ! -f "$ROOT/edge/.dev.vars" ]]; then
  echo "WARNING: edge/.dev.vars missing — cp edge/.dev.vars.example edge/.dev.vars"
  exit 1
fi
echo "edge/.dev.vars: present"
exit 0
