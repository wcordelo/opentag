#!/bin/sh
# Start optional Notion MCP sidecar, then the AG-UI triage runtime on :8200.
set -eu

PORT="${PORT:-8200}"
export PORT
export NOTION_MCP_URL="${NOTION_MCP_URL:-http://127.0.0.1:3001/mcp}"

if [ -n "${NOTION_MCP_AUTH_TOKEN:-}" ] && [ -n "${NOTION_TOKEN:-}" ]; then
  echo "[entrypoint] starting Notion MCP sidecar on :${NOTION_MCP_PORT:-3001}"
  npx tsx scripts/start-notion-mcp.ts &
else
  echo "[entrypoint] Notion MCP skipped (NOTION_TOKEN / NOTION_MCP_AUTH_TOKEN unset)"
fi

echo "[entrypoint] LINEAR_TEAM_KEY=${LINEAR_TEAM_KEY:-(unset)}"
echo "[entrypoint] starting AG-UI runtime on :${PORT}"
exec npx tsx runtime.ts
