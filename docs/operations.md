# OpenTag operations guide

Status: **current runbook**
Updated: **2026-07-14**

This guide covers local validation, deployment units, configuration, health
checks, logs, and failure diagnosis. Setup from scratch starts in
[setup.md](../setup.md); system design is in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Deployment map

```mermaid
flowchart LR
    Operator["Operator"]
    Bot["opentag-bot<br/>wrangler.bot.toml"]
    Agent["opentag-agent<br/>workers/agent-runtime"]
    Harness["opentag-harness<br/>workers/sandbox"]
    Research["opentag-orchestrator<br/>wrangler.research.toml"]

    Operator -->|"deploy:bot"| Bot
    Operator -->|"deploy:agent"| Agent
    Operator -.->|"explicit opt-in deploy"| Harness
    Operator -.->|"deploy:research"| Research

    Bot -->|"AGENT_RUNTIME"| Agent
    Bot -.->|"HARNESS"| Harness
    Bot -.->|"RESEARCH_TASKS"| Research
```

The bot and AG-UI agent are the normal production pair. Research is optional.
The Claude Code harness is packaged and tested but remains opt-in; the bot's
service binding is commented in both bot Wrangler configs until an operator
deploys and connects it.

## Local prerequisites

- Node.js 22 for parity with GitHub Actions
- npm for `edge/` and harness packages
- pnpm for the root runtime/research tests
- Wrangler authentication for deploy or remote tailing
- Docker for harness-image build/smoke validation
- Workers Paid for Cloudflare Containers
- TinyGo and `wasm-opt` only when rebuilding the optional WASM dispatcher

## Install and validate

### Bot spine, exact CI sequence

```bash
cd edge
npm ci
npm run typecheck
npm test
npm run test:e2e
```

This is the sequence in `.github/workflows/edge-ci.yml`. It uses only
`edge/package-lock.json`, so dependencies required by files included in
`edge/tsconfig.json` must be declared at the edge package level. The harness
container types therefore pin `@cloudflare/containers` directly in `edge`.

### Harness Worker package

```bash
cd edge/workers/sandbox
npm ci
npm run typecheck
```

The edge test suite already covers the router, egress policy, wire contract,
harness server, tool host, and client. Build the image when Docker is available:

```bash
docker build --platform linux/amd64 \
  -f containers/harness/Dockerfile \
  -t opentag-harness:local .
```

The harness pins an `amd64` Ubuntu package and Cloudflare's deployment image
target is `linux/amd64`. Apple Silicon Docker otherwise selects `arm64` and
fails at `dpkg` before project code runs.

### Root runtime and research

```bash
pnpm install
pnpm run check-types
pnpm test
```

## Local development topology

```mermaid
flowchart LR
    Slack["Slack"] --> Tunnel["Tunnel or deployed Request URL"]
    Tunnel --> Bot["wrangler dev<br/>usually :8787"]
    Bot --> Agent["pnpm runtime<br/>:8200"]
    Bot -.-> Research["npm run dev:research<br/>usually :8788"]
    Bot -.-> Harness["Harness Worker/container<br/>optional"]
```

Start the default conversational path:

```bash
# terminal 1, repository root
pnpm runtime

# terminal 2
cd edge
cp .dev.vars.example .dev.vars
npm run dev
```

Root `pnpm start` and `pnpm dev` intentionally exit with a pointer to the edge
Worker. They are not alternate Slack bots.

For signed local probes:

```bash
cd edge
./scripts/e2e-local.sh
./scripts/e2e-smoke-local.sh
```

## Configuration ownership

| Name | Kind | Owner | Purpose |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | Secret | Bot | Slack Web API |
| `SLACK_SIGNING_SECRET` | Secret | Bot | Slack HMAC verification |
| `SLACK_BOT_USER_ID` | Var | Bot | Exact installed bot user ID required by trusted rich-payload mentions |
| `SLACK_TRUSTED_TRIGGER_ACTORS` | Var | Bot | Exact `bot:B...` / `app:A...` allowlist; unset disables the feature |
| `AGENT_URL` | Secret/string | Bot | AG-UI request URL/path |
| `AGENT_RUNTIME` | Service binding | Bot | Same-zone call to `opentag-agent` |
| `AGENT_AUTH_HEADER` | Secret | Bot + agent | Optional AG-UI authentication |
| `ADMIN_SECRET` | Secret | Bot | `/admin/*`, `/debug/*`, `/tasks/start` |
| `SESSION_VIEWER_BASE_URL` | Var | Bot | Public bot origin for signed, expiring session links |
| `QUICK_BASE_DOMAIN` | Var | Bot | Artifact host suffix eligible for final action cards |
| `DEFERRED_INGRESS` | Durable Object binding | Bot | Stable quick-click and delayed-file jobs, owned before Slack acknowledgement |
| `BOT_SELF` | Service binding | Bot | Authenticated alarm replay into `opentag-bot` |
| `SLACK_RATE_LIMIT` | Durable Object binding | Bot | Cross-isolate per-channel Slack dispatch reservations |
| `BLOBS` | R2 binding | Bot + harness + research | Durable staged attachments and research blobs; bot/harness must name the same bucket |
| `DELIVERY_METRICS` | Analytics Engine binding | Bot | Confirmed `streamed`, `answer_visible`, and `failed_size_limit` outcomes |
| `INTERNAL_SECRET` | Secret | Bot + research | Internal research authentication |
| `RESEARCH_TASKS` | Service binding | Bot | `opentag-orchestrator` |
| `HARNESS` | Service binding | Bot | Optional `opentag-harness` call |
| `HARNESS_URL` | Var/secret string | Bot | Harness base URL and path fallback |
| `HARNESS_AUTH_TOKEN` | Secret | Bot + harness | `/turn` and `/interrupt` bearer |
| `HARNESS_REPO_URL` | Var | Bot | Default repository for coding turns |
| `HARNESS_ALLOWED_REPO_HOSTS` | Var | Harness | Allowed git hosts, default `github.com` |
| `HARNESS_ALLOWED_REPO_ORGS` | Var | Harness | Required non-empty organization allowlist |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Secret | Harness Worker | Injected at outbound boundary |
| `GITHUB_TOKEN` | Secret | Harness Worker | Private clone and approved remote writes |
| `OPENTAG_TOOL_BIN` | Var | Harness | Optional tool-host executable |
| `OPENAI_API_KEY` | Secret | Agent | Default AG-UI model |
| `LINEAR_API_KEY` | Secret | Agent | Linear MCP |
| `LINEAR_TEAM_KEY` | Secret/var | Agent | Linear team display name or ID |
| `NOTION_TOKEN`, `NOTION_MCP_AUTH_TOKEN` | Secret | Agent | Optional Notion sidecar |

Same-zone Worker calls should use service bindings. `AGENT_URL` and
`HARNESS_URL` still supply a request URL/path, but public `workers.dev` fetches
between Workers in the same zone can fail with Cloudflare 1042.

AG-UI requests carry the exact execution ID to the named runtime Container.
Stop calls `/opentag/control/interrupt` through `AGENT_RUNTIME` and only reports
success after the runtime returns matching accepted/quiescent proof. Signed
`/sessions/:token` links are read-only, expire after seven days, return
`Cache-Control: private, no-store`, and require `ADMIN_SECRET` as their HMAC
key; rotate that secret to revoke outstanding links.

## Deploy the AG-UI agent

```bash
cd edge/workers/agent-runtime
npm ci
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put LINEAR_TEAM_KEY
# optional: AGENT_MODEL, NOTION_TOKEN, NOTION_MCP_AUTH_TOKEN, AGENT_AUTH_HEADER
npm run deploy
```

Keep `TriageContainer.envVars` as a class field. A getter is shadowed by the
Containers base class and silently drops runtime secrets.

## Deploy the bot

```bash
cd edge
npx wrangler secret put SLACK_BOT_TOKEN --config wrangler.bot.toml
npx wrangler secret put SLACK_SIGNING_SECRET --config wrangler.bot.toml
npx wrangler secret put AGENT_URL --config wrangler.bot.toml
npx wrangler secret put ADMIN_SECRET --config wrangler.bot.toml
npx wrangler secret put INTERNAL_SECRET --config wrangler.bot.toml
npm run deploy:bot
```

Slack Request URLs must point to the deployed bot Worker:

- `/slack/events`
- `/slack/commands`
- `/slack/interactions`

After a Slack scope change, reinstall the app and refresh the bot token secret.
The Linear requester-assignee flow requires `users:read.email` on the installed
token, not only in the manifest.

## Deploy and connect the harness

This is an explicit operator action. Complete all steps before uncommenting the
bot binding.

1. Set a non-empty organization allowlist in
   `edge/workers/sandbox/wrangler.toml` or its deployment environment.
2. Verify the harness `BLOBS` R2 binding names the same bucket as the bot
   binding. Staged references fail closed if the binding, object, size, or
   digest does not match.
3. Configure harness Worker secrets:

```bash
cd edge/workers/sandbox
npx wrangler secret put HARNESS_AUTH_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

`CLAUDE_CODE_OAUTH_TOKEN` can replace `ANTHROPIC_API_KEY` where appropriate.

1. Add the `HARNESS` service binding to `edge/wrangler.bot.toml`:

```toml
[[services]]
binding = "HARNESS"
service = "opentag-harness"
```

1. Set matching bot configuration:

```bash
cd ../..
npx wrangler secret put HARNESS_AUTH_TOKEN --config wrangler.bot.toml
# configure HARNESS_REPO_URL as a non-secret var or deployment-specific value
npm run deploy:bot
```

1. Verify `/health`, a read-only harness turn, Stop during a live turn, a local
   commit-only coding turn, then a separately approved push/PR turn.

Do not place real Anthropic or GitHub tokens in the container image or bot turn
body. The container receives sentinels; outbound handlers replace them.

## Deploy research

```bash
cd edge
npm run deploy:research
```

This command rebuilds the optional WASM dispatcher first. The research Worker
must share `INTERNAL_SECRET` with the bot and have delivery/model secrets needed
by its configured adapters.

The research Worker is not a Slack Request URL. Its `/slack/*` routes return
`410 slack_demoted` intentionally. A confirmed final research delivery includes
Retry, Dig deeper, and Export buttons. Those clicks return to
`opentag-bot`'s `/slack/interactions`, acquire exact durable pre-admission using
the click identity, and then enter the ordinary synthetic-turn sink.

## Health checks

| Surface | Request | Expected |
| --- | --- | --- |
| Bot | `GET /health` | `ok`, product, StateStore, bot engine, trusted-rich-trigger readiness |
| Agent | Agent Worker health route | Worker/Container reachable |
| Harness Worker | `GET /health` | `{ok:true, worker:"opentag-harness"}` |
| Harness container | Internal `GET /health` | Claude Code version |
| Research | `GET /health` | `role:"research-task"`, `slack:"demoted"` |

The bot's `/debug/store` is admin-authenticated and exercises KV, list, lock,
and dedup. Do not expose admin secrets in shell history or logs.

## Structured lifecycle metrics

The current system emits JSON log lines rather than a Prometheus exporter.
Useful metric names include:

| Metric | Meaning |
| --- | --- |
| `turn_started` | Exact turn admitted and entering execution |
| `turn_completed` | Runtime completed normally |
| `turn_failed` | Lifecycle raised before confirmed completion |
| `turn_duplicate` | Stable execution already handled |
| `turn_duplicate_pre_admission` | Slack redelivery rejected before enrichment |
| `turn_concurrent_rejected` | Another execution owns the thread/session |
| `busy-note:<threadKey>` | Durable dedup namespace for bounded concurrent-turn feedback |
| `turn_interrupted` | Exact turn was stopped |
| `turn_interrupted_pre_execution` | Stop won before runtime work |
| `fallback_sent` | Alarm recovery made an answer visible |
| `error_visible` | Explicit error/retry surface reached Slack |
| `obligation_deferred` | Recovery found live or ambiguous execution |
| `obligation_silent_clear` | Terminal/interrupt state required no new post |
| `obligation_stale_execution` | Session `executing` marker outlived its exact active-turn row; crash recovery proceeds |
| `stop_command_received` | Stop parser accepted the Slack message |
| `streamed` | Slack confirmed the first non-final streamed update |
| `answer_visible` | Slack confirmed the final answer render |
| `failed_size_limit` | Slack definitively rejected the final answer for size and confirmed the bounded visible error |
| `late_file_repair_timeout` | A correlated delayed upload did not reach exact thread idle within the repair window |
| `session_history_compacted` | Alarm recovery compacted events through a caller-proven replay cursor |
| `session_history_compaction_error` | Best-effort compaction failed after the visible obligation was safely served |
| `trusted_rich_mention_admitted` | Exact allowlisted rich-payload mention entered durable admission |
| `trusted_rich_mention_ignored` | Rich-trigger candidate failed closed with a bounded reason |
| `runtime_default_selected` | Runtime selection source labels for the accepted turn |
| `permission_snapshot_generated` | Redacted snapshot generation by actor kind and surface |

Filter by `threadKey` and `executionId` to reconstruct a turn. The same exact
execution ID should appear across pre-admission, SessionEventDO, harness, Stop,
and final render logs.

## Inspect effective permissions

- Agent turn: call the reserved `show_permissions` tool.
- Operator: `GET /admin/permissions?teamId=<team>&channelId=<channel>` with the
  existing admin bearer. Responses are `Cache-Control: no-store`.
- Claude harness: run `opentag permissions` during the active execution.

These surfaces are informational. They never grant a tool, secret, network
destination, git operation, or write. Automation snapshots deliberately omit
MCP endpoint and secret-reference names.

## Configure channel runtime defaults

Use `/config runtime show`, `/config runtime set --harness claude-code
[--model <id-or-alias>]`, and `/config runtime clear`. The authenticated
`POST /admin/config` surface accepts the same `runtimeDefaults` object and
validation. Effective precedence is explicit message flag, sticky thread
choice, channel default, then deployment default. Existing sticky threads keep
masking a changed channel default until overwritten or expired.

If a channel selects Claude Code while the harness is disconnected, the turn
fails visibly and never falls back to AG-UI. Reasoning defaults and unsupported
harnesses are rejected.

## Enable trusted rich-payload mentions

The feature is disabled unless both variables are valid:

```text
SLACK_BOT_USER_ID=U0123456789
SLACK_TRUSTED_TRIGGER_ACTORS=bot:B0123456789,app:A0123456789
```

Matching is exact against verified raw Slack IDs. A trusted actor must also
contain an exact `<@SLACK_BOT_USER_ID>` mention inside `blocks` or
`attachments`; top-level text alone does not use this fallback. Own-bot posts,
untrusted actors, malformed payloads, DMs without a rich mention, edits, and
other subtypes fail closed. No new Slack scope or reinstall is required by this
source change.

Invalid allowlist tokens are ignored and reported only as a bounded count in
the startup warning and `GET /health`. An allowlist with no valid entries, or
valid entries without a valid bot user ID, makes readiness fail with
`invalid_config` or `missing_target_id`; raw payload text and invalid tokens are
never logged.

Rollback is immediate: unset `SLACK_TRUSTED_TRIGGER_ACTORS`. Clear channel
defaults with `/config runtime clear`.

For a concurrent rejection, confirm the request is genuinely distinct. Stable
redeliveries intentionally stay silent; a distinct ask should produce no more
than one busy note per thread per minute.

## Failure diagnosis

### Slack event acknowledged but no answer

1. Find `turn_started`, `turn_failed`, or `turn_interrupted` for the execution.
2. Check `SESSION_EVENTS` state: live execution, terminal done, or interrupt
   tombstone.
3. Check whether a render obligation remains and when its alarm is due.
4. Look for `obligation_deferred`, `fallback_sent`, or `error_visible`.
5. `obligation_stale_execution` means the runtime owner stopped refreshing its
   active-turn row; the alarm intentionally treats the session marker as a
   crash orphan instead of deferring forever.
6. Verify the final Slack render was confirmed, not merely attempted.

Do not delete the obligation as a first response. It is the recovery mechanism.

Every request-time Slack client reserves its dispatch slot in the
`SLACK_RATE_LIMIT` Durable Object named for the channel. Production requests
are therefore spaced at one call per second across Worker isolates, and a Slack
`Retry-After` response replays the identical form body through the same durable
discipline. Render-obligation alarm recovery is a separate sequential Durable
Object owner and persists its own deferred/retry timing.

Quick clicks and delayed-file repairs are stored in `DEFERRED_INGRESS` and have
an alarm armed before Slack receives HTTP 200. The alarm calls the authenticated
`BOT_SELF` route, retries with bounded backoff, and retains an exhausted record
plus `deferred_ingress_exhausted` metric rather than silently discarding work.

If a live AG-UI render was visible but replay has no output, look for
`session_event_mirror_failed`. Session output and tool events are canonical
before delivery; an append or replay failure suppresses runtime/final delivery
and leaves the exact active turn plus obligation retryable. The obligation must
still produce an explicit retry/error surface rather than remain silent.

### Stop says nothing or appears stuck

1. Confirm the message qualifies: threaded or DM stop, or a top-level channel
   stop that mentions the bot.
2. Confirm execution and Stop derived the same thread key.
3. Inspect the active-turn status: `cancelled`, `cancel_controlled`,
   `cancel_ack_in_flight`, or `cancel_confirmed`.
4. If a research effect exists, verify cancellation returned both `cancelled`
   and `quiescent`.
5. If a harness effect exists, inspect `/interrupt` and process-group cleanup.
6. Leave the row for the alarm continuation if the Slack acknowledgement was
   ambiguous.

### HITL button appears dead

- Use a card created by current code; older cards may not contain `choiceId`.
- Confirm `/slack/interactions` reaches `opentag-bot`.
- Inspect the HTTP status. A `503` means durable persistence failed and Slack
  should retry; a false `200` would be a bug.
- Verify `hitl-id:<choiceId>` and cancellation tombstones in `BOT_STATE`.

### Agent returns Cloudflare 1042

The bot is fetching a same-zone Worker publicly. Configure `AGENT_RUNTIME` (or
`HARNESS`) service binding and retain the URL only for the request path.

### Linear assignee email is missing

- Reinstall the Slack app after adding `users:read.email`.
- Refresh `SLACK_BOT_TOKEN` locally and in Cloudflare.
- Verify the installed token's `x-oauth-scopes` header.
- Keep Slack Web API bodies form-urlencoded; JSON `users.info` can omit/fail the
  profile lookup.

### Harness rejects repository

- Use canonical `https://host/org/repo` or `.git` URL with no credentials,
  port, query, or fragment.
- Confirm the host and lowercase org are allowlisted.
- Confirm `codingTask` includes a repository.
- Confirm IDs match the `ot1e_` / `ot1m_` wire formats.

### Harness rejects a staged attachment

- Confirm bot and harness `BLOBS` bindings point to the same R2 bucket.
- Check for `staged_attachment_store_unavailable`, `not_found`,
  `size_mismatch`, or `digest_mismatch`; each is a deliberate fail-closed
  boundary and the turn is not silently run without the attachment.
- The authenticated harness frontend resolves at most 32 MiB decoded across
  at most five attachments. The container keeps rejecting any staged ref that
  crosses its boundary unresolved.

### Harness cannot push or create a PR

- Confirm the Slack remote-git approval completed durably for the exact turn.
- Confirm `GITHUB_TOKEN` is a harness Worker secret.
- Push only `opentag/session-<session-prefix>`.
- Use repository-scoped REST for PR creation, not GraphQL.
- Include the exact standalone requester attribution line.
- A successful Claude exit is insufficient; inspect the postcondition error.

### Harness turn ends without `done`

The outer client writes explicit `error` and failed `done` events so the event
log does not remain live forever. Investigate container transport, process exit,
timeout, or event-mapping errors using the preserved failure kind.

### CI passes locally but clean CI fails

Reproduce from `edge/` using `npm ci` under Node 22. Do not rely on a nested
`workers/sandbox/node_modules`; edge TypeScript includes `workers/**/*.ts` and
must declare their compile-time packages in `edge/package.json`.

## Rollback and safety

- Bot, agent, harness, and research deploy independently.
- Disconnecting the `HARNESS` binding makes coding or explicitly harness-routed
  turns fail visibly. The bot must not silently reinterpret that intent as an
  AG-UI turn; restore the binding or deliberately select an AG-UI mode.
- Do not delete DO migrations from a deployed config.
- Do not force-push a recovery commit over concurrent Bugbot or automation
  changes.
- Do not deploy from an unclean tree without reviewing the exact package and
  config being shipped.
- Keep remote git, Slack messages to real channels, and Cloudflare deploys
  behind explicit user/operator approval.

## Post-deploy smoke checklist

- [ ] Bot `/health` returns expected bindings/product metadata.
- [ ] Mention receives a streaming answer and status clears.
- [ ] Thread follow-up works without a new mention.
- [ ] `/agent` uses the same lifecycle and never double-posts its ack.
- [ ] Supported `--model`/`--claude` flags are stripped and saved only when the
  Claude harness is connected; `-rsn`/unsupported providers fail visibly.
- [ ] `stop` during AG-UI suppresses later output.
- [ ] Create/Cancel HITL works across isolates.
- [ ] Linear create defaults to requester profile email.
- [ ] Quick Retry creates a synthetic turn as the clicking user.
- [ ] Research start delivers to the same thread; Stop cancels it quiescently.
- [ ] Harness read-only turn reaches only allowlisted hosts.
- [ ] Harness Stop revokes git approval and terminates descendants.
- [ ] Approved coding turn creates a new commit and attributed PR.
- [ ] Unapproved coding turn cannot push or create a PR.
- [ ] Alarm recovery produces one visible terminal outcome, never two.
