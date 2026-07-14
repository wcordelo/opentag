# Acknowledges the official Cloudflare Sandbox SDK container template
# (`@cloudflare/sandbox`'s bundled Dockerfile — see
# node_modules/@cloudflare/sandbox/Dockerfile — which is Ubuntu 22.04 +
# Python/Node/Bun for general-purpose agent sandboxes). This is a leaner
# OpenTag-specific variant: Node 22 + git + curl only, since agent-runner.js
# is the sole process this image runs today. Extend this image (Python,
# additional CLIs, etc.) if a later phase's MCP tools need more system deps.
#
# The Claude Code coding harness (GOAL.md Phase A5 / SPEC.md §4.4) is a
# SEPARATE image, not built here: see ../../containers/harness/Dockerfile
# (Ubuntu 22.04 + Node 20 + pinned claude-code CLI + ripgrep/jq/fd/uv),
# which runs edge/workers/sandbox/{harness-server,tool-host}.ts. This
# agent-runner.js scaffold is unrelated infrastructure (pm/impl/verify
# flavor sandboxes) and is left as-is.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent-runner.js ./

# ContainerManager.start() exposes this port via the Sandbox SDK
# (`sandbox.exposePort(8080, { hostname })`) to mint the preview URL.
EXPOSE 8080

CMD ["node", "agent-runner.js"]
