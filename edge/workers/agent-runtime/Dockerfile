# AG-UI triage Container image.
# Build context: repo root (wrangler image_build_context = "../../..").
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lean dependency set for runtime.ts + Notion MCP sidecar.
COPY edge/workers/agent-runtime/container-package.json ./package.json
# Match root pnpm resolution (ai-openai peers newer @tanstack/ai than we pin).
RUN npm install --omit=dev --legacy-peer-deps

COPY lib/triage-agent.ts ./lib/
COPY runtime.ts ./
COPY scripts/start-notion-mcp.ts ./scripts/
COPY edge/workers/agent-runtime/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=8200
ENV NOTION_MCP_URL=http://127.0.0.1:3001/mcp
# Fallback if Worker secret is missing on a stale container; Worker envVars override.
ENV LINEAR_TEAM_KEY=Berendo
EXPOSE 8200

CMD ["./entrypoint.sh"]
