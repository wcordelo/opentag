# syntax=docker/dockerfile:1.7
#
# containers/harness/Dockerfile — the Claude Code harness container
# (GOAL.md Phase A5 / SPEC.md §4.4). Wired up behind edge/workers/sandbox/
# (see the [[containers]] comment in edge/workers/sandbox/wrangler.toml —
# actual deploy wiring is gated per GOAL.md house rule 6).
#
# Two stages: `build` compiles the dependency-free TypeScript sources
# (edge/workers/sandbox/{harness-server,tool-host}.ts) to plain ESM
# JavaScript so the final image needs no `npm install` / TypeScript at
# runtime; `harness` is the actual Ubuntu 22.04 runtime image.

# ─────────────────────────────────────────────────────────────────────────
# Stage: build — compile harness-server.ts + tool-host.ts to .js
# ─────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /build

# Only the two source files are needed to compile — they're dependency-free
# (Node stdlib only), so no package.json / npm install is required here.
COPY edge/workers/sandbox/harness-server.ts edge/workers/sandbox/tool-host.ts ./

# Pin the TypeScript compiler version for reproducibility. Compiling to
# ES2022/ESM (not CommonJS) keeps `import.meta` usable in the sources
# unchanged — see the `isMain` guards in both files — and Node 20 runs
# native ESM `.js` files directly once the output directory is marked
# `"type": "module"` (done below in the runtime stage).
RUN npm install -g typescript@5.6.3 \
    && tsc \
      --target ES2022 \
      --module ES2022 \
      --moduleResolution node \
      --esModuleInterop \
      --skipLibCheck \
      --outDir dist \
      harness-server.ts tool-host.ts

# ─────────────────────────────────────────────────────────────────────────
# Stage: harness — Ubuntu 22.04 runtime
# ─────────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS harness

ENV DEBIAN_FRONTEND=noninteractive

# ── Base system packages ───────────────────────────────────────────────
# curl/ca-certificates: needed by the Node/uv installers below and by any
#   HTTPS access the agent makes.
# git: per-session `git clone --depth=1` (SPEC §3.6) + work-branch checkout.
# ripgrep, jq, fd-find: SYSTEM_PROMPT.md's [Environment] promises these.
#   Ubuntu packages the `fd-find` binary as `fdfind`; symlink it to `fd` so
#   the prompt's guidance ("prefer `fd`") is actually true.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      git \
      ripgrep \
      jq \
      fd-find \
      gnupg \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 (NodeSource — reproducible, pinned major) ───────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── uv (astral installer) — Python policy in SYSTEM_PROMPT.md is uv-only ─
# Installed for root here; symlinked into a PATH directory so the non-root
# `harness` user (created below) can run it without per-user reinstall.
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# ── Claude Code CLI, pinned to an exact version ────────────────────────
# Pin matches the version centaur's own sandbox Dockerfile has already
# proven stable (services/sandbox/Dockerfile ARG CLAUDE_CODE_VERSION).
# Bump deliberately, not via `@latest`, so a harness rebuild is
# reproducible and doesn't silently pick up CLI behavior changes.
ARG CLAUDE_CODE_VERSION=2.1.154
RUN npm install -g --force "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version | grep -F "${CLAUDE_CODE_VERSION}"

# ── Non-root user ───────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash -u 1001 harness

# ── Harness server + tool host (compiled JS from the build stage) ──────
# "type": "module" makes Node treat the compiled .js as ESM, matching the
# `--module ES2022` output above (and the `import.meta` main-module guard
# in both sources).
RUN mkdir -p /opt/harness \
    && printf '{"type":"module"}\n' > /opt/harness/package.json
COPY --from=build /build/dist/harness-server.js /opt/harness/harness-server.js
COPY --from=build /build/dist/tool-host.js /opt/harness/tool-host.js
COPY containers/harness/SYSTEM_PROMPT.md /opt/harness/SYSTEM_PROMPT.md

# Per-session workdirs (see harness-server.ts's WORK_ROOT) live here.
RUN mkdir -p /work && chown -R harness:harness /work /opt/harness

USER harness
WORKDIR /opt/harness

# harness-server.ts reads SYSTEM_PROMPT_PATH (defaults to this path) and
# spawns `claude` (CLAUDE_BIN, defaults to "claude" on PATH).
ENV PORT=8080 \
    SYSTEM_PROMPT_PATH=/opt/harness/SYSTEM_PROMPT.md \
    WORK_ROOT=/work \
    CLAUDE_BIN=claude

# ANTHROPIC_API_KEY is passed through from the container's environment at
# run time (Cloudflare Container env / secrets binding) — never baked into
# the image.

EXPOSE 8080

CMD ["node", "/opt/harness/harness-server.js"]
