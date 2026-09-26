# AGENTS.md

## Cursor Cloud / agent instructions

- **Product docs:** [`docs/PRODUCT.md`](./docs/PRODUCT.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/centaur-port.md`](./docs/centaur-port.md) · [`docs/extending.md`](./docs/extending.md) · [`docs/operations.md`](./docs/operations.md)
- **Slack product surface:** Cloudflare edge (`edge/`) — Events API bot Worker + StateStore. Production Worker: `opentag-bot` (`npm run deploy:bot`). Channels deps: `edge/vendor/` tarball + npm.
- **Agent brain (production):** `edge/workers/agent-runtime/` Container (`opentag-agent`). Bot uses **`AGENT_RUNTIME` service binding** + `AGENT_URL` path (same-zone `workers.dev` fetch → CF 1042).
- **Agent brain (dev-only):** root `pnpm runtime` (`runtime.ts` / `lib/triage-agent.ts`) on `:8200`. Hardcoded to the **OpenAI adapter** (`@tanstack/ai-openai`): needs a working `OPENAI_API_KEY`; `AGENT_MODEL` only swaps the OpenAI model id and `ANTHROPIC_API_KEY` does not drive it. Runtime accepts AG-UI runs at `POST /api/copilotkit/agent/triage/run` (emits `RUN_STARTED` then streams; a bad/over-quota key surfaces as a `RUN_ERROR` SSE event, not a startup crash).
- **Research tasks:** optional `edge/wrangler.research.toml` (internal); not on the CI critical path.
- **Claude Code harness:** production-enabled `edge/workers/sandbox/` Worker + `containers/harness/` image. Native `claudecode` and `claudex` (Claude Code through the private CLIProxyAPI/Codex service) share the same tools, isolation, Stop, egress, and git postconditions. Coding intent cannot silently fall back to AG-UI.
- **Technical locks:** [`docs/DECISIONS.md`](./docs/DECISIONS.md) — especially exact identity/fences/Stop §§11–13 and remote-git/postconditions §§14–16.

### Root `pnpm start` is not the Slack bot

`pnpm start` / `pnpm dev` exit with a pointer to `cd edge && npm run dev`. There is no Socket Mode / Railway Slack bot.

### `edge/` is the testable CF target

```bash
cd edge
npm ci
npm test                 # bot-spine unit only (includes durable-choice + thread-memory)
npm run test:e2e         # StateStore workerd
npm run typecheck
npm run deploy:bot       # production bot
npm run deploy:agent     # production AG-UI Container
npm run dev              # local bot Worker (Slack Events)
```

Harness validation is separate:

```bash
cd edge/workers/sandbox
npm ci
npm run typecheck
cd ../claudex-proxy
npm ci
npm run typecheck
```

Do not deploy any Worker or Container without explicit user approval.

Slack Request URLs must point at **`opentag-bot`**, not the research orchestrator.

### Running services locally (dev environment already installed)

Deps are installed by the startup update script (`pnpm install` at root; `npm ci` in
`edge/` and `edge/workers/sandbox/`). Root is **pnpm**, everything under `edge/` is **npm**.

Two services run in dev without Slack credentials:

- **AG-UI runtime:** `pnpm runtime` → `http://localhost:8200`. Smoke test with a real model
  turn (uses the OpenAI adapter; `OPENAI_API_KEY` is provided as a secret in this env):
  `POST /api/copilotkit/agent/triage/run` with body
  `{"threadId":"t","runId":"r","state":{},"messages":[{"id":"m","role":"user","content":"hi"}],"tools":[],"context":[],"forwardedProps":{}}`
  → streams `RUN_STARTED` … `TEXT_MESSAGE_CONTENT` … `RUN_FINISHED` SSE.
- **Bot Worker:** `cd edge && npm run dev` (add `-- --port 8787`). Needs `edge/.dev.vars`
  (`cp .dev.vars.example .dev.vars`; gitignored). Smoke tests: `GET /health` (exercises the
  DO/SQLite spine) and a signed `POST /slack/events` `url_verification` challenge
  (HMAC `v0:{ts}:{body}` with `SLACK_SIGNING_SECRET`, headers `X-Slack-Request-Timestamp` +
  `X-Slack-Signature`). `RESEARCH_TASKS` shows `[not connected]` locally — harmless.

Gotchas:
- A full Slack round-trip (event → reply) needs real `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`
  (not present here), so only ingress verification + the AG-UI turn can be tested locally.
- `npm ci` wipes `node_modules`; restart any running `wrangler dev` after a reinstall.

### Linear create pitfalls

- `LINEAR_TEAM_KEY` = team **display name** (e.g. `Berendo`), not a bare key like `CPK`.
- Bot token needs **`users:read.email`** (reinstall + refresh secret after scope changes).
- Slack Web API: use **form-urlencoded** (`edge/src/slack/web-api.ts`) — JSON `users.info` skips email.
- HITL Create/Cancel needs `choiceId` durable poll (`edge/src/hitl/durable-choice.ts`).

### Cursor Cloud specific instructions

Cloud env config lives in [`.cursor/environment.json`](./.cursor/environment.json). Boot `install` refreshes both lockfiles (`pnpm` at repo root, `npm ci` in `edge/`). Node 22 matches CI.

**Validate after pull (exact CI sequence):**

```bash
cd edge && npm run typecheck && npm test && npm run test:e2e
# optional root runtime:
pnpm test
```

**Local hello-world (terminals auto-start in Cloud):**

1. Agent brain: `pnpm runtime`, then POST with `tools`/`context` arrays required:

```bash
curl -sN -X POST http://127.0.0.1:8200/api/copilotkit/agent/triage/run \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"ping"}],"tools":[],"context":[]}'
```

Expect `RUN_STARTED` (funded `OPENAI_API_KEY` streams a reply; bad/over-quota → `RUN_ERROR`, not a crash).

2. Bot Worker: ensure `edge/.dev.vars` exists (`cp edge/.dev.vars.example edge/.dev.vars` is fine for unit/dev), then `npm --prefix edge run dev` → `GET /health` (checks include `deferredIngress` / `slackRateLimit` after the Centaur/OpenTag 2 merges).

**Secrets (Cursor Secrets tab / env):**

| Secret | Needed for |
| --- | --- |
| `OPENAI_API_KEY` | Real AG-UI triage turns (required; funded key) |
| `LINEAR_API_KEY` + `LINEAR_TEAM_KEY` | Linear create/list tools |
| `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` | Live Slack Events (tunnel or deployed Worker) |
| `SLACK_BOT_USER_ID` + `SLACK_TRUSTED_TRIGGER_ACTORS` | Trusted rich-payload mentions (disabled until both set) |
| `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` | Optional harness only — not the triage runtime |

Do not deploy Workers/Containers from Cloud without explicit user approval. `pnpm run check-types` may fail on a pre-existing `lib/research/adapters/storage-postgres.ts` issue; prefer `edge` typecheck/tests for the product surface.

## Bot design principles

Rules for Slack bot judgment, memory, and retrieval (`edge/`).

1. **Make bot judgments typed decisions** (Jev Choice / Noul / Score → probabilities), not text generation you parse back out. Why: decision models return structured choices fast and beat general-purpose LLM reranking. ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201))
2. **Rerankers sort; they never drop.** Order by Score-10 or Noul probability; never delete candidates with a Noul threshold. Why: Noul-as-a-delete-gate "kept nothing"; sort and Score-10 both worked. ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201))
3. **Fallback to prior order (RRF)** when a reranker errors or times out. Why: keeps the rerank slot low-risk. ([`edge/src/memory/retrieval/rerank.ts`](./edge/src/memory/retrieval/rerank.ts))
4. **Relevance floors only on prefetched context** — never on results the agent explicitly requested; calibrate on labels first. Why: a floor on requested hits silently hides answers. (internal design notes: Supermemory + Jev for the Slack bot)
5. **Memory gates judge whole threads**, not isolated sentences. Why: per-sentence filtering broke meaning in assistant turns and early lines referenced later. ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201))
6. **Tag, don't drop.** Store gate scores as metadata; skip indexing only obvious noise (bot messages, reactions, acks) after shadow data supports it. Why: dropped text should stay searchable, and decisions often hide in casual chat. ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201); internal design notes: Supermemory + Jev for the Slack bot)
7. **Decide whether memory is needed before fetching** — harness-level classifier, not the generation model; honor "without using memory". Why: models are "very bad at deciding *when* some memory should be helpful." ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201))
8. **Flag stale memory; don't hide it.** Keep dates on memory; mark superseded or contradicted hits rather than dropping them. Why: dates let the agent discount lagging profiles; dated corrections beat silent overwrites. ([Dhravya Shah, Instinct memory](https://x.com/DhravyaShah/status/2101745550752428340))
9. **Shadow new judgments first** — compute and log beside current logic, change nothing, until logs justify switching. Why: shadow-only changes are low risk and produce labels later steps need. (internal design notes: Supermemory + Jev for the Slack bot)
10. **Measure against a baseline on a fixed labeled eval set before shipping** (e.g. MRR@5 and p95 vs RRF-only); calibrate thresholds on our data and pin the model version once tuned. Why: cookbook thresholds are examples; confidence measures concentration, not correctness; `jev-latest` moves. ([Dhravya Shah, Jev & memory](https://x.com/DhravyaShah/status/2103314339239428201); internal design notes: Supermemory + Jev for the Slack bot)
11. **Build on low effort; verify on high.** Implement and iterate at low/medium effort; run verification and edge-case testing at high effort. Why: extra effort mainly buys verification and edge-case coverage. ([Thariq, Spending your effort](https://x.com/trq212/status/2103576349499855160))

Testing rules are in [Testing](#testing) (E2E-first); rule 10's eval set is in addition to those tests, not a replacement.

## Testing

- Never write unit tests after you write the code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact (for example a screenshot, HTML report, saved response fixture, or deterministic log the next run can compare).
- If you must test a system in isolation, first write down all the ways it could fail, then write the code (and the tests that exercise those failures).

Review checklist for every test:

- Would a wrong refactor still make this test pass? If yes, it is low-signal. Delete or rewrite it.
- Does the E2E leave an artifact someone can re-run and compare?
- Are AGENTS.md (or CLAUDE.md / project instructions) updated so the next agent inherits these rules?
