# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
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
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

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

# Install Claude Code from the same integrity-locked npm graph, without the
# compiler-only dependencies used by the build stage.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS claude-cli
WORKDIR /opt/claude
COPY containers/harness/package.json containers/harness/package-lock.json ./
RUN npm ci --omit=dev \
    && test "$(./node_modules/.bin/claude --version)" = "2.1.154 (Claude Code)"

# ─────────────────────────────────────────────────────────────────────────
# Stage: harness — Ubuntu 22.04 runtime
# ─────────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS harness

ENV DEBIAN_FRONTEND=noninteractive

# ── Base system packages ───────────────────────────────────────────────
# curl/ca-certificates: needed by release-asset installs below and by any
#   HTTPS access the agent makes.
# git: per-session `git clone --depth=1` (SPEC §3.6) + work-branch checkout.
# ripgrep, jq, fd-find: SYSTEM_PROMPT.md's [Environment] promises these.
#   Ubuntu packages the `fd-find` binary as `fdfind`; symlink it to `fd` so
#   the prompt's guidance ("prefer `fd`") is actually true.
# The timestamped Ubuntu archive freezes both package indexes and transitive
# dependencies. The base image has no CA bundle, so bootstrap TLS from exact
# Ubuntu package URLs whose bytes BuildKit verifies before dpkg sees them.
ARG UBUNTU_SNAPSHOT=20260701T000000Z
ADD --checksum=sha256:08e75ff19d4fab73a1e2f92140a9e12b7cab36b4dc8efb764ec9963b57dbb455 \
  http://archive.ubuntu.com/ubuntu/pool/main/o/openssl/openssl_3.0.2-0ubuntu1.25_amd64.deb /tmp/openssl.deb
ADD --checksum=sha256:6e8cdcc8c86103acd4fc14649eac62ff2037108389074a7b167567af33c32245 \
  http://archive.ubuntu.com/ubuntu/pool/main/c/ca-certificates/ca-certificates_20260601~22.04.1_all.deb /tmp/ca-certificates.deb
RUN dpkg -i /tmp/openssl.deb /tmp/ca-certificates.deb \
    && rm /tmp/openssl.deb /tmp/ca-certificates.deb \
    && printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} jammy main universe" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} jammy-updates main universe" \
      "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} jammy-security main universe" \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/* \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates=20260601~22.04.1 \
      curl=7.81.0-1ubuntu1.25 \
      git=1:2.34.1-1ubuntu1.17 \
      ripgrep=13.0.0-2ubuntu0.1 \
      jq=1.6-2.1ubuntu3.2 \
      fd-find=8.3.1-1ubuntu0.1 \
      python3=3.10.6-1~22.04.1 \
      util-linux=2.37.2-4ubuntu3.5 \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Copy the exact Node/npm distribution from the digest-pinned build image;
# this replaces the moving NodeSource setup channel entirely.
COPY --from=build /usr/local/ /usr/local/

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

# Read-only local introspection for the exact current execution. The file is
# generated inside the disposable execution HOME and is never an authorization
# source; the outer Worker remains authoritative for egress and credentials.
RUN <<'EOF'
cat > /usr/local/bin/opentag <<'SH'
#!/bin/sh
case "${1:-}" in
  permissions)
    if [ -z "${OPENTAG_PERMISSIONS_FILE:-}" ] || [ ! -r "${OPENTAG_PERMISSIONS_FILE}" ]; then
      echo "OpenTag permission snapshot is unavailable for this execution." >&2
      exit 2
    fi
    exec /bin/cat "${OPENTAG_PERMISSIONS_FILE}"
    ;;
  *)
    echo "Usage: opentag permissions" >&2
    exit 2
    ;;
esac
SH
chmod 0755 /usr/local/bin/opentag
EOF

# ── uv — exact release archive, checksum verified before extraction ────
ARG UV_VERSION=0.6.14
ARG UV_AMD64_SHA256=0aaf451c391d3913823bfb8ed354b446dcfd0553a32ed8266611e4181c61fd51
RUN curl -fsSLo /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    && echo "${UV_AMD64_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /usr/local/bin \
      uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
    && rm /tmp/uv.tar.gz \
    && test "$(uv --version)" = "uv ${UV_VERSION}"

# ── Claude Code CLI — exact npm lockfile graph from claude-cli stage ───
COPY --from=claude-cli /opt/claude /opt/claude
RUN ln -s /opt/claude/node_modules/.bin/claude /usr/local/bin/claude \
    && test "$(claude --version)" = "2.1.154 (Claude Code)"

# Fail the build if the immutable sources ever stop producing the promised
# harness toolchain.
RUN test "$(node --version)" = "v20.20.2" \
    && test "$(npm --version)" = "10.8.2" \
    && git --version | grep -Fx "git version 2.34.1" \
    && rg --version | grep -Fx "ripgrep 13.0.0" \
    && jq --version | grep -Fx "jq-1.6" \
    && fd --version | grep -Fx "fd 8.3.1" \
    && python3 --version | grep -Fx "Python 3.10.12" \
    && curl --version | grep -F "curl 7.81.0"

# ── Non-root user ───────────────────────────────────────────────────────
# /home/harness is deliberately not a writable persistence surface. Each
# request receives a fresh /work/<executionId>/home from harness-server.ts;
# its Claude/XDG config is quarantined and removed at the end of the turn.
RUN useradd -m -s /bin/bash -u 1001 harness \
    && chown root:root /home/harness \
    && chmod 0555 /home/harness

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

# Per-session workdirs (see harness-server.ts's WORK_ROOT) live here. Packaged
# harness code and the authoritative system prompt stay root-owned and
# read-only: Claude and repository code run as UID 1001, so neither can alter
# the server that executes the next request or weaken the appended prompt.
# Only the per-session work root is writable by the harness identity.
RUN mkdir -p /work \
    && chown harness:harness /work \
    && chmod 0755 /work \
    && chown -R root:root /opt/harness \
    && find /opt/harness -type f -exec chmod 0444 {} + \
    && chmod 0555 /opt/harness \
    && test "$(stat -c '%u:%g:%a' /opt/harness)" = "0:0:555" \
    && test "$(stat -c '%u:%g:%a' /opt/harness/harness-server.js)" = "0:0:444" \
    && test "$(stat -c '%u:%g:%a' /opt/harness/tool-host.js)" = "0:0:444" \
    && test "$(stat -c '%u:%g:%a' /opt/harness/turn-contract.js)" = "0:0:444" \
    && test "$(stat -c '%u:%g:%a' /opt/harness/package.json)" = "0:0:444" \
    && test "$(stat -c '%u:%g:%a' /opt/harness/SYSTEM_PROMPT.md)" = "0:0:444" \
    && test "$(stat -c '%u:%g:%a' /home/harness)" = "0:0:555" \
    && ! setpriv --reuid=1001 --regid=1001 --init-groups \
      sh -c 'printf tamper >> /opt/harness/SYSTEM_PROMPT.md' \
    && ! setpriv --reuid=1001 --regid=1001 --init-groups \
      sh -c 'printf tamper >> /opt/harness/harness-server.js' \
    && ! setpriv --reuid=1001 --regid=1001 --init-groups \
      sh -c 'rm /opt/harness/SYSTEM_PROMPT.md' \
    && ! setpriv --reuid=1001 --regid=1001 --init-groups \
      sh -c 'mkdir /home/harness/.claude' \
    && setpriv --reuid=1001 --regid=1001 --init-groups \
      sh -c 'mkdir -m 700 /work/ot1e_build-home-check && mkdir -m 700 /work/ot1e_build-home-check/home && HOME=/work/ot1e_build-home-check/home sh -c "mkdir \"\$HOME/.claude\" && printf ok > \"\$HOME/.claude/state\""' \
    && test "$(stat -c '%u:%g:%a' /work/ot1e_build-home-check)" = "1001:1001:700" \
    && test "$(stat -c '%u:%g:%a' /work/ot1e_build-home-check/home)" = "1001:1001:700" \
    && test "$(cat /work/ot1e_build-home-check/home/.claude/state)" = "ok" \
    && rm -rf /work/ot1e_build-home-check

WORKDIR /opt/harness

# harness-server.ts reads SYSTEM_PROMPT_PATH and spawns Claude headlessly.
# `bypassPermissions` prevents an unattended coding turn from hanging on an
# approval prompt. It is not the security boundary: the non-root container,
# isolated /work session, repository/egress allowlists, guarded git/gh
# wrappers, and server-side credential stripping enforce that boundary.
ENV PORT=8080 \
    HOME=/home/harness \
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
