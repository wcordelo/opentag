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

# Install the complete compile-time toolchain from a lockfile. The sources use
# Node built-ins and NodeJS types, so @types/node is required even though the
# runtime itself has no npm dependencies.
COPY containers/harness/package.json containers/harness/package-lock.json ./
RUN npm ci

COPY edge/workers/sandbox/harness-server.ts edge/workers/sandbox/tool-host.ts edge/workers/sandbox/turn-contract.ts ./

# Compile with the lockfile-pinned TypeScript version. Compiling to
# ES2022/ESM (not CommonJS) keeps `import.meta` usable in the sources
# unchanged — see the `isMain` guards in both files — and Node 20 runs
# native ESM `.js` files directly once the output directory is marked
# `"type": "module"` (done below in the runtime stage).
RUN ./node_modules/.bin/tsc \
      --target ES2022 \
      --module ES2022 \
      --moduleResolution node \
      --esModuleInterop \
      --strict \
      --skipLibCheck \
      --outDir dist \
      harness-server.ts tool-host.ts turn-contract.ts

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
      util-linux \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI is installed from an immutable release asset and checksum rather
# than a moving apt channel. This is the authorized PR creation surface.
ARG GH_VERSION=2.93.0
ARG GH_AMD64_SHA256=5371f77155e5dd81b6e897c379431f734949b99b99ae1f01c5e3ab6d3795cf4d
RUN curl -fsSLo /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
    && echo "${GH_AMD64_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && gh --version | grep -F "gh version ${GH_VERSION}"

# A deterministic service identity lets coding turns create real commits.
# HTTPS credentials stay in the environment and never enter clone/push argv.
RUN git config --system user.name "OpenTag Agent" \
    && git config --system user.email "opentag-agent@users.noreply.github.com" \
    && printf '%s\n' \
      '#!/bin/sh' \
      'case "$1" in' \
      '  *Username*) printf "%s\\n" "x-access-token" ;;' \
      '  *Password*) printf "%s\\n" "${GITHUB_TOKEN:-}" ;;' \
      '  *) exit 1 ;;' \
      'esac' \
      > /usr/local/bin/opentag-git-askpass \
    && chmod 0755 /usr/local/bin/opentag-git-askpass

# These wrappers are usability rails, not the trust boundary. The Worker-side
# outbound policy independently authorizes the exact repo/branch request and
# injects credentials. `gh pr create` is translated to REST because opaque
# GraphQL mutation node IDs cannot be scoped safely by the egress policy.
RUN <<'EOF'
cat > /usr/local/bin/git <<'SH'
#!/bin/sh
exec /usr/bin/git "$@"
SH
cat > /usr/local/bin/gh <<'SH'
#!/bin/sh
if [ "${1:-}" = pr ] && [ "${2:-}" = create ]; then
  shift 2
  title="" body="" base="main"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title|-t) title=${2:-}; shift 2 ;;
      --body|-b) body=${2:-}; shift 2 ;;
      --base|-B) base=${2:-}; shift 2 ;;
      --repo|-R|--head|-H) shift 2 ;; # forced below
      *) shift ;;
    esac
  done
  [ -n "${OPENTAG_REPO_SLUG:-}" ] && [ -n "${OPENTAG_WORK_BRANCH:-}" ] && \
    [ -n "${OPENTAG_EXECUTION_ID:-}" ] || {
    echo "PR context unavailable" >&2; exit 77;
  }
  exec /usr/bin/gh api --method POST "repos/${OPENTAG_REPO_SLUG}/pulls" \
    --header "x-opentag-execution-id: ${OPENTAG_EXECUTION_ID:-}" \
    -f "title=${title:-OpenTag agent changes}" -f "body=${body}" \
    -f "head=${OPENTAG_WORK_BRANCH}" -f "base=${base}" --jq .html_url
fi
exec /usr/bin/gh "$@"
SH
chmod 0755 /usr/local/bin/git /usr/local/bin/gh
EOF

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
    && printf '{"type":"module"}\n' > /opt/harness/package.json \
    && printf '#!/bin/sh\nexec node /opt/harness/tool-host.js "$@"\n' > /usr/local/bin/opentag-tool-host \
    && chmod 0755 /usr/local/bin/opentag-tool-host
COPY --from=build /build/dist/harness-server.js /opt/harness/harness-server.js
COPY --from=build /build/dist/tool-host.js /opt/harness/tool-host.js
COPY --from=build /build/dist/turn-contract.js /opt/harness/turn-contract.js
COPY containers/harness/SYSTEM_PROMPT.md /opt/harness/SYSTEM_PROMPT.md

# Make the optional custom-tool bridge discoverable to every Claude turn.
# It is intentionally disabled unless the Container Worker passes a real
# OPENTAG_TOOL_BIN; the image no longer pretends an `opentag-tools` CLI exists.
RUN <<'EOF'
cat >> /opt/harness/SYSTEM_PROMPT.md <<'PROMPT'

[OpenTag custom tool bridge]
|The `opentag-tool-host` JSONL bridge is installed. It is available only when `OPENTAG_TOOL_BIN` is non-empty; check that variable before use. When unset, use Claude Code built-in tools only.
|To call a configured custom tool, pipe one JSON object to `opentag-tool-host`, for example: `printf '%s\n' '{"id":"1","tool":"linear","method":"search","arguments":{"query":"bug"}}' | opentag-tool-host`.
PROMPT
EOF

# Per-session workdirs (see harness-server.ts's WORK_ROOT) live here.
RUN mkdir -p /work && chown -R harness:harness /work /opt/harness

WORKDIR /opt/harness

# harness-server.ts reads SYSTEM_PROMPT_PATH and spawns Claude headlessly.
# `bypassPermissions` prevents an unattended coding turn from hanging on an
# approval prompt. It is not the security boundary: the non-root container,
# isolated /work session, repository/egress allowlists, guarded git/gh
# wrappers, and server-side credential stripping enforce that boundary.
ENV PORT=8080 \
    SYSTEM_PROMPT_PATH=/opt/harness/SYSTEM_PROMPT.md \
    WORK_ROOT=/work \
    CLAUDE_BIN=claude \
    CLAUDE_PERMISSION_MODE=bypassPermissions

# The Cloudflare HTTPS interception CA exists only after container startup.
# Refresh Ubuntu's system bundle as root, then permanently drop privileges.
# NODE_EXTRA_CA_CERTS also covers Node/Claude Code runtimes that do not consult
# the distro trust store for every TLS connection.
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
RUN <<'EOF'
cat > /usr/local/bin/opentag-harness-entrypoint <<'SH'
#!/bin/sh
set -eu
test -r /etc/cloudflare/certs/cloudflare-containers-ca.crt
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt \
  /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
update-ca-certificates >/dev/null
exec setpriv --reuid=1001 --regid=1001 --init-groups \
  node /opt/harness/harness-server.js
SH
chmod 0755 /usr/local/bin/opentag-harness-entrypoint
EOF

EXPOSE 8080

CMD ["/usr/local/bin/opentag-harness-entrypoint"]
