# Implementation Notes

## Current consolidated status (2026-07-13)

Phases A1–A5 are implemented. The optional harness is code-complete and
test-covered; deployment and the production bot binding remain explicitly
gated. The chronological entries below are point-in-time records, so early
“known gaps” may be superseded by later exact-execution work.

The current lifecycle includes stable `ot1e_`/`ot1m_` wire IDs, pre-admission,
per-thread active/effect/render fences, SessionEventDO admission and replay,
never-silent obligations, durable Stop continuation, exact research quiescence,
Worker-enforced harness egress, remote-git HITL, process-group interruption,
and commit/PR postconditions. DMs use `DM_SCOPE`; channel mentions use their
root timestamp; top-level slash commands use channel scope. Duplicate
redeliveries stay silent, while distinct concurrent asks receive one durable-
deduped busy note.

Current references: [ARCHITECTURE.md](./ARCHITECTURE.md) ·
[docs/centaur-port.md](./docs/centaur-port.md) ·
[docs/extending.md](./docs/extending.md) ·
[docs/operations.md](./docs/operations.md)

## Phase A5 — Claude Code harness container, container-side (2026-07-12)

### Status
Container-side half of A5 only (GOAL.md split this phase across two concurrent agents;
the `edge/src/**` half — `edge/src/harness/client.ts`, agent-turn wiring — is owned
elsewhere and was read-only reference here). Typecheck clean (`cd edge && npm run
typecheck`); `cd edge && npx vitest run test/harness-server.test.ts
test/tool-host.test.ts` 47/47; full suite 258/258 after this work. Docker build not
run (no docker available; not required per mission scope).

### What landed
- **`edge/workers/sandbox/harness-server.ts`** — plain-Node HTTP server (runs INSIDE
  the container, not a Worker) implementing the pinned wire contract: `GET /health`,
  `POST /turn` streaming `application/x-ndjson`. All reasoning-bearing logic is a pure,
  exported function: `assemblePrompt`, `mapStreamJsonLine` (claude-code stream-json →
  our NDJSON), `finalizeEvents` (done-always-last invariant), `buildClaudeArgs`,
  `createExecutionTracker`/`decideTurnAdmission` (409 dedup), `createSessionQueue`
  (per-session serialization, cross-session concurrency), `ensureWorkdir` (git clone +
  work-branch checkout), `workBranchName`, `summarizeToolInput`, `truncateSummary`. The
  HTTP server itself (`createHarnessServer`) wires these together; it only binds a port
  when run as the main module (`isMain` guard via `import.meta.url`), so importing the
  file in tests never starts a listener.
- **`edge/workers/sandbox/tool-host.ts`** — TS port of centaur's `centaur_tool_host.py`
  (106 LOC). Same stdin/stdout line-delimited JSON protocol, same tiny surface: shells
  out to `${OPENTAG_TOOL_BIN:-opentag-tools} call <tool> <method> <json-args>` via
  `spawnSync` with a timeout, emits `{"type":"result","turn_id":id,"result":"<json>"}`,
  prints `__OPENTAG_TOOL_HOST_READY` on start (opentag's rename of centaur's sentinel).
- **`containers/harness/Dockerfile`** — two-stage build: `build` stage compiles both
  `.ts` files to ES2022/ESM `.js` with a pinned `typescript@5.6.3` (no npm deps needed
  at runtime); `harness` stage is Ubuntu 22.04 + curl/git/ripgrep/jq/fd (symlinked from
  `fdfind`) + Node 20 (NodeSource) + uv (astral installer) + `@anthropic-ai/claude-code`
  pinned to `2.1.154` (same version centaur's proven sandbox Dockerfile pins). Non-root
  `harness` user; `/opt/harness/package.json` sets `"type":"module"` so Node runs the
  compiled ESM output; `EXPOSE 8080`; `CMD node /opt/harness/harness-server.js`.
- **`containers/harness/SYSTEM_PROMPT.md`** — adapted from
  `centaur/services/sandbox/SYSTEM_PROMPT.md` per SPEC.md §2.7 (full section accounting
  below).
- **`edge/test/harness-server.test.ts`** (34 tests) + **`edge/test/tool-host.test.ts`**
  (13 tests) — cover every item the mission asked for: event mapping (assistant text,
  tool_use, result success/failure, malformed/blank lines, ignored system/user types),
  the done-always-last invariant (no-done → fallback appended; done-in-middle →
  truncated so done stays last; already-terminal → unchanged), the duplicate-execution
  409 decision (pure `decideTurnAdmission`/`ExecutionTracker`), prompt assembly with/
  without transcript and requesterContext (5 cases), plus bonus coverage
  (`createSessionQueue` serialization/concurrency/error-continuation,
  `buildClaudeArgs` flag shape, `workBranchName`/`summarizeToolInput`/`truncateSummary`).
  `tool-host.test.ts` exercises `runTool`/`handleRequestLine` end-to-end through a real
  spawned Node "fake tool bin" script (chmod +x, shebang) standing in for
  `opentag-tools` — covers success, nonzero exit, and timeout paths via a real
  `spawnSync` call, not a mock.
- Comment-only additions to `edge/workers/sandbox/Dockerfile` and `wrangler.toml`
  pointing at `containers/harness/` (both left otherwise untouched — verified via
  `git diff`, no `[[containers]]` wiring added, per the mission's explicit scope limit).

### Event-mapping table (claude-code stream-json → our NDJSON)
| stream-json line | our NDJSON event(s) |
|---|---|
| `{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}` | `{"kind":"output","payload":{"text":"…"}}` per text block |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"…","input":{…}}]}}` | `{"kind":"output","payload":{"tool":"…","summary":"…"}}` (summary = first present of `command/file_path/path/pattern/url/query/description`, truncated to 120 chars, else just the tool name) |
| `{"type":"assistant",...,"content":[{"type":"thinking",...}]}` | (not surfaced — see deviations) |
| `{"type":"result","is_error":false,"result":"…"}` | `{"kind":"done","payload":{"ok":true,"summary":"…truncated to 500…"}}` |
| `{"type":"result","is_error":true,...}` | `{"kind":"done","payload":{"ok":false,"summary":"…"}}` |
| `{"type":"system",...}` / `{"type":"user",...}` | `[]` (init/tool-result echoes, intentionally not surfaced) |
| malformed JSON / blank line / unrecognized shape | `[]` (never throws) |
| process exits non-zero without ever emitting `result` | synthesized at the live-stream level (not in `mapStreamJsonLine`): `{"kind":"error",...}` then `{"kind":"done","payload":{"ok":false,...}}` |
| stream ends with no `result` at all (offline/testable form) | `finalizeEvents()` appends `{"kind":"done","payload":{"ok":false,"summary":"No result received from Claude Code"}}` |

### SYSTEM_PROMPT.md — section accounting (SPEC §2.7)
- **Copied verbatim:** `[Writing Quality Gate]`, `[User Interaction]`,
  `[GitHub PR Attribution]`, `[Python policy]`, `[Rust policy]`, `[Parallel tool calls]`
  (extracted from centaur's nested `[Tool CLI access]` section into its own heading),
  `[Format complaints are correction signals]`, `[User-visible artifact verification]`.
- **Adapted:** `[Container Lifecycle]` (K8s/pod refs → "CF Container... may be
  recycled"); `[Environment]` (centaur's `~/github/{org}/{repo}` read-only-mount +
  `git-branch` CLI model doesn't apply — opentag clones per-session directly into the
  workdir with the work branch already checked out by `harness-server.ts`, so this is a
  rewrite, not a copy, describing what's actually true for this container); new
  `[Chat delivery — do not self-post]` section generalizing centaur's Slack-specific
  "don't call the slack tool to reply" rule (still relevant: the harness's stdout *is*
  the delivery path).
- **Omitted (centaur-specific, per mission scope):** `[Self-introspection]`, `[Model
  and Harness Switching Answers]` (Amp/Codex/Bedrock — out of scope, SPEC §9),
  `[Research and Grounding]` (persona-overlay references), `[Authoritative
  internal-data answers]`, `[Authoritative deployment-capability answers]`, `[Named
  skill resolution]`, `[Ethereum Mainnet RPC]`, `[Common Tool CLIs]` +
  `[Tool discovery]` (centaur's own tool CLI examples — opentag has none yet),
  `[MPP fallback discovery]`, all `[Slack channel references]` /
  `[Slack files and attachments]` / `[Slack file uploads]` sections (centaur's own
  `slack` tool CLI, doesn't exist in this image), `[Document processing — built-in
  libraries]` (python-docx/openpyxl/pymupdf/etc. are NOT installed in
  `containers/harness/Dockerfile` — copying that section would promise capabilities
  the image doesn't have).
- Added a short `[Identity]` header naming OpenTag, as instructed.

### Decisions / deviations from the literal mission text
1. **Added `--permission-mode bypassPermissions`** to the `claude` invocation
   (`buildClaudeArgs`), beyond the literal `claude -p <prompt> --output-format
   stream-json --verbose` line in the mission prompt. Without it, any tool call in a
   headless/non-interactive turn blocks on an approval prompt nobody is present to
   answer, and the turn silently hangs until `TURN_TIMEOUT_MS` — defeating the point of
   a coding harness. Matches the pattern centaur's own Claude Code harness
   (`crates/harness-server/src/claude.rs`) already uses in production. Escape hatch:
   `CLAUDE_PERMISSION_MODE=""` env var disables it without a code change.
2. **`--append-system-prompt` (not `--append-system-prompt-file`).** Checked
   `claude --help` directly (locally installed CLI, v2.1.119): no
   `--append-system-prompt-file` flag exists. Used the documented
   `--append-system-prompt <prompt>` string flag, reading `SYSTEM_PROMPT_PATH` into
   memory (cached after first read) and passing its contents as the argv value — the
   "else" branch the mission prompt anticipated.
3. **No token-level text deltas.** The pinned claude invocation omits
   `--include-partial-messages`, so `assistant` stream-json lines carry whole content
   blocks, not incremental deltas. `mapStreamJsonLine` therefore emits one `output`
   text event per text *block* (still incremental turn-over-turn, just coarser than
   token streaming). Noted inline in the source and here rather than silently
   diverging from the wire-contract doc's phrase "assistant text deltas".
4. **`thinking` content blocks are dropped**, not surfaced as `output` — not in the
   pinned NDJSON contract's event vocabulary (`text` and `tool` are the only two
   `output` payload shapes) and centaur's own normalizer treats them as
   passthrough-only content, not primary answer text.
5. **Model passthrough via `--model` only**, not a `CLAUDE_MODEL` env var read by the
   `claude` binary itself — the mission's "`CLAUDE_MODEL`/`--model`" phrasing reads as
   *either* mechanism satisfies the requirement; `CLAUDE_MODEL` is a centaur-internal
   convention their own Rust wrapper reads (`ClaudeCodeHarness::default_model`), not
   something the upstream `claude` CLI consumes itself. `harness-server.ts` still sets
   `env.CLAUDE_MODEL` when a model override is present (harmless, future-proofs against
   a hypothetical CLI env fallback) but the actual mechanism is `--model`.
6. **`edge/workers/sandbox/*.ts` typecheck via the existing root `edge/tsconfig.json`**
   (its `include` already globs `workers/**/*.ts`) — no separate tsconfig needed;
   confirmed via `cd edge && npm run typecheck`. The *build-time* compile
   (TS → JS for the container image) uses a separate, unrelated `tsc` invocation inside
   `containers/harness/Dockerfile`'s `build` stage with its own explicit flags
   (`--module ES2022`, no project file), so the two compilations don't interact.
7. **`ensureWorkdir` / git clone / `claude --version` are integration-only** — not unit
   tested (would require a real git binary + network, or a real `claude` binary; the
   mission scope explicitly excludes requiring Docker). `tool-host.ts`'s `runTool` IS
   unit tested end-to-end via a real spawned process (a temp-file Node script standing
   in for `opentag-tools`), since that path has no external-network dependency.

## Phase A4 — Quick-action cards (2026-07-12)

### Status
All GOAL.md A4 done criteria pass (review agent verdict). Typecheck clean; full suite
199/199. Implemented by the orchestrator directly (the assigned subagent died to a
session usage limit); reviewed extra-skeptically by an independent agent.

### What landed
- **`edge/src/slack/quick-card.ts`** — centaur port, generalized: base domain is a
  parameter (no fixed Quick site domain). `findQuickSiteUrls(text, baseDomain)`
  (ReDoS-safe, lookalike-domain-proof regex), `buildQuickDeployCard(FromRefs)`
  (Re-generate / View files / Delete buttons), 50-block cap with a reserved block for
  the omission note. Buttons get custom `quick_*` action_ids via
  `quickActionHandle(kind)` — a `{ id }` object standing in for a registry-stamped
  onClick handler (the channels-slack renderer reads `.id`; the action registry only
  registers function handlers, so it skips these — verified both).
- **`edge/src/slack/quick-actions.ts`** — decode (`parseQuickAction` etc., defensive
  JSON) + `handleQuickAction`: builds a synthetic `IncomingTurn` authored by the
  CLICKING user (resolved via users.info) and feeds `adapter.getSink().onTurn()` — the
  bot's normal ingress, so clicks inherit event dedup (deterministic
  `quick:{channel}:{messageTs}:{action_ts}` eventId — verified the framework dedups on
  it), turn locks, render obligations, and status. No parallel button path (SPEC §6).
- **`edge/src/worker.ts`** — /slack/interactions routes `quick_*` payloads to
  handleQuickAction INSTEAD of the generic interaction path (never double-handled;
  HITL persist + feedback handler confirmed unreachable by quick clicks).
- **`edge/src/components/cards.ts`** — `IssueList` gains "🔁 Retry search"
  (`quick_retry`, `{type:"issue_list",heading}` ref; the agent recovers the query from
  the standard per-turn transcript re-injection).

### Decisions / known gaps
1. **`buildQuickDeployCard` has no production call site yet** — GOAL A4 only requires
   the generalized functions + wiring to exist. The posting hook (scan final agent
   messages for artifact URLs) lands when opentag has a real artifact domain (A5-era).
2. Quick-action prompts were verified safe against A3 flag-stripping (no `--flag`
   token boundaries in the generated text).
3. The `quick_*`-never-reaches-framework-dispatch invariant relies on worker.ts being
   the sole `handleInteractionPayload` caller with `isQuickInteraction` checked first;
   if that ever changes, an unregistered quick id would be silently swallowed by the
   framework's expired-action handler.
4. Review fixes applied: `replyTarget.messageTs` now carries the clicked message ts
   (not the thread root) and `recipientUserId` is set on both branches — parity with
   `handleEventsBody`.
5. **Centaur working-tree note:** `~/Documents/centaur` has pre-existing local drift
   (`AGENTS.md` modified, untracked `docs/public/md/capabilities.md`) dated before this
   session. Nothing from this build touched centaur; the drift is the user's to keep
   or discard — deliberately NOT reverted.

## Phase A3 — Model/harness overrides (2026-07-12)

### Status
All GOAL.md A3 done criteria pass (review agent verdict). Typecheck clean; full suite
186/186.

### What landed
- **`edge/src/slack/overrides.ts`** — centaur port with exactly the SPEC §2.2 trims:
  `--amp` and provider flags (`--bedrock`/`--meta`) removed; aliases updated
  (fable→claude-fable-5, opus→claude-opus-4-8, sonnet→claude-sonnet-5,
  haiku→claude-haiku-4-5-20251001). Regex/stripping logic byte-identical to centaur.
- **`edge/src/store/thread-overrides.ts`** — `resolveThreadOverrides`: sticky
  model/harness per thread in store kv `thread:overrides:{conversationKey}` (30-day
  TTL, rows live in ConversationStateDO SQLite — satisfies the "DO persists sticky
  state" criterion via the shared KV surface rather than typed columns). Reasoning
  (`-rsn`) is per-turn only, never sticky (matches centaur).
- **`edge/src/agent-turn.ts`** — flags parsed + stripped for string and contentParts
  prompts; cleanedText is what reaches thread memory, thread title, transcript, and the
  agent. Flags-only message → sticky saved + "✓ Saved: …" confirmation, no agent run.
  Effective model/harness surfaces to the agent as a "model preference" context entry.
- **`edge/src/tasks/runtime.ts`** — `StartTaskRequest.model?` forwarded in the
  /research POST body (contract for A5; orchestrator may ignore it today).

### Decisions / known gaps
1. **The live AG-UI runtime cannot switch models per-thread** (OpenAI adapter, env-level
   AGENT_MODEL in lib/triage-agent.ts). A3 delivers parsing/sticky/plumbing; real
   passthrough is the A5 container (`CLAUDE_MODEL` / `--model` CLI). The context entry
   keeps the agent honest about a recorded-but-not-yet-active preference.
2. **Inherited limitation:** flag stripping is not code-fence aware — a multi-line
   ``` fence containing e.g. `npm run foo --model x` gets its flag stripped (verified
   byte-identical behavior in centaur). Follow-up candidate before wide rollout.
3. When two conflicting shortcuts appear in one message (`--sonnet --opus`), alias-table
   order wins, not textual order — same as centaur.
4. `startTask` call sites don't pass `effectiveModel` yet — deliberate, lands with A5.

## Phase A2 — Session DO + never-silent guarantee (2026-07-12)

### Status
All GOAL.md A2 done criteria pass (independent review agent verdict). Typecheck clean;
full suite 112/112. Not yet deployed — `wrangler deploy` gates on user approval (house
rule 6).

### What landed
- **`edge/src/store/session-event-do.ts`** — `SessionEventDO` (one instance per thread
  key): SQLite `events` table + KV slots (`session:created/executing/interrupted`), RPC
  `create` (idempotent, harness-mismatch → wipe + restart), `execute` (executionId
  dedup), `appendEvent` (done/error clears executing), `replay(afterEventId)`,
  `interrupt`, `getState`. Engine/DO split mirrors `sql-state-engine.ts` for node:sqlite
  testability.
- **`edge/src/store/conversation-state-do.ts` + `schema.ts`** — `render_obligations`
  table (PK thread_key, executionId-guarded upserts), RPC
  `obligationSet/Clear/Get`. The single DO alarm is multiplexed: hourly GC sweep time
  persisted in storage KV; alarm serves due obligations then reschedules to
  min(sweep, earliest deadline). Delete-then-post + capped re-insert (3 attempts)
  prevents double-posting. Fallback: replay `output` events → post recovered content
  (`fallback_sent`) or generic retry card (`error_visible`); user-interrupted sessions
  clear silently; still-executing sessions re-arm (`obligation_deferred_live`) instead
  of posting.
- **`edge/src/bot-engine.ts`** — obligation written before `runBundledAgentTurn`
  (executionId = randomUUID, threadKey `slack:{channel}:{threadTs}`), cleared on
  success; in the catch, cleared only after the error card posts (else left for alarm
  recovery). Metrics: `turn_started/turn_completed/turn_failed` as structured JSON logs.
- **`edge/src/slack/stop-command.ts`** — byte-identical centaur port.
- **`edge/src/slack/stop-routing.ts` + `worker.ts`** — stop detection before bot
  routing (`event_callback` + human message/app_mention only); on match: dedup on
  `stop:{event_id}` (Slack redelivery), interrupt SessionEventDO, clear obligation,
  clear assistant status, post "🛑 Stopped.", `stop_command_received` metric.
- **`wrangler.toml`/`wrangler.bot.toml`** — `SESSION_EVENTS` → `SessionEventDO`
  bindings + `new_sqlite_classes` migrations (v3-session-events / v2-session-events).
- Tests: `session-event-do.test.ts`, `render-obligation.test.ts`,
  `stop-command-routing.test.ts` (mock `cloudflare:workers` + node:sqlite pattern).

### Decisions / deviations
1. **Obligation timeout 20 min** (> 15-min turn lock, > 10-min HITL window + slack):
   review flagged 16 min as a thin margin against legitimately long turns double-posting;
   widened, and the alarm additionally defers when the session reports the execution
   still live.
2. **threadKey race fix:** status/obligation thread ts derivation prefers the
   deterministic conversationKey scope over request-scoped `reactTarget` (which a
   concurrent turn in the same isolate can overwrite); reactTarget is only the DM
   fallback.
3. **`SessionEventsRpc` cast interfaces:** `replay()`'s `payload: unknown` fails
   workerd's RPC `Serializable` inference (stub return collapses to `never`), so call
   sites cast stubs to hand-written interfaces. Review verified signatures match the DO;
   keep them in sync when SessionEventDO's surface changes.
4. **Known gaps (accepted):** stop command in a top-level (unthreaded) turn derives a
   different threadKey than the original turn (users stop from within threads);
   `message_changed` edits are not stop-detected; "🛑 Stopped." posts even in idle
   threads; no integration test for bot-engine's obligation wiring (engines are
   unit-tested); `forwardedMessageIds`/`executedMessageIds` caps (SPEC §2.6) deferred to
   the phase that forwards messages.
5. AG-UI turns don't call `SessionEventDO.execute()` yet (no session events until the
   A5 harness), so today's alarm fallback is always the `error_visible` card; replay
   recovery becomes real when the harness emits events.

## Phase A1 — Streaming render + status (2026-07-12)

### Status
All GOAL.md A1 done criteria pass. `cd edge && npm run typecheck` clean; `npm test` 76/76
(baseline before A1 was 68 pass / 4 fail — see "Pre-existing bug fixed" below).
Awaiting user gate (manual Slack verification) before A2.

### What landed
- **`edge/src/slack/conflate.ts`** — verbatim port of centaur's conflate.ts; only the type
  import changed (`@centaur/rendering` → `./chunk-types.js`). Diff-verified byte-identical
  otherwise.
- **`edge/src/slack/chunk-types.ts`** — local `ChatSDKStreamChunk` union
  (`markdown_text | task_update | plan_update`) mirroring centaur's
  `packages/rendering/src/chat-sdk.ts` for the three ported variants.
- **`edge/src/slack/cloudflare-slack-adapter.ts`** — `stream()` rewritten: one placeholder
  `postMessage` immediately, chunks wrapped as markdown chunks → `conflateChatSdkStream` →
  throttled `chat.update` (`streamUpdateIntervalMs` option, default 800 ms), guaranteed final
  full-state update, mid-stream error tolerance, "⚠️ (stream interrupted)" marker + rethrow on
  source failure. New public `setStatus`/`setTitle` pass-throughs.
- **`edge/src/slack/stream-render.ts`** — block building: ≤3,000-char mrkdwn section blocks,
  ≤50 blocks, 35k fallback-text cap, newline-preferring splits.
- **`edge/src/slack/web-api.ts`** — added `setTitle` (`assistant.threads.setTitle`,
  error-swallowing like `setStatus`).
- **`edge/src/bot-engine.ts`** — hourglass reaction timer replaced with
  `adapter.setStatus({status:"Thinking…"})` before the agent turn and `status:""` in
  `finally`; skipped entirely when no `/^\d+\.\d+$/` thread ts can be derived.
- **Tests** — new `edge/test/slack-stream.test.ts` (placeholder-once + per-chunk updates +
  truncation + error path); `test/cloudflare-slack-adapter.test.ts` now mocks fetch per its
  own "no live Slack" contract.

### Pre-existing bug fixed (not in the A1 spec)
4 tests in `test/cloudflare-slack-adapter.test.ts` timed out on main before this work.
Root cause: **Node/undici `fetch` hangs indefinitely on a POST with `body: ""`**, and
`web-api.ts`'s `api("auth.test", {})` serialized `{}` to exactly that. Fixed in
`web-api.ts` (`body: encoded || undefined`) — this was also a latent production hang for
any Worker path that called `authTest()` with an unset `botUserId`. Tests additionally
mock fetch now.

### Deviations / decisions (resolved)
1. **`adapter.stream()` is not on the live @mention path — accepted (user decision).**
   The live path renders via `createRunRenderer` → `@copilotkit/channels-slack`'s
   `ChunkedMessageStream` (placeholder + 800 ms-throttled `chat.update`), which already
   streams incrementally. The rewritten `stream()` stays as the now-correct
   `Thread.stream()` path. `conflate.ts` is intentionally NOT wired into the text path:
   its purpose is `task_update`/`plan_update` card conflation — the hook point when
   structured chunks land (A5 harness / native streaming), not raw-markdown text.
2. **`setTitle` wired in `agent-turn.ts`** (SPEC §5-A1 item 6): on the first turn per
   `conversationKey` (durable `dedup.seen("title:<key>")`, 30-day TTL) the first user
   message (≤100 chars) becomes the assistant thread title. Best-effort, error-logged.
3. **`setStatus`/`setTitle` thread_ts corrected:** `InboundMessageTarget` now carries
   `threadTs` (thread root), plumbed from `normalizeSlackEvent` through
   `rememberInboundMessage`. Status/title derivation prefers
   `reactTarget.threadTs` → conversationKey scope → message ts, regex-validated —
   assistant.threads.* gets the thread root, not the reply ts.
4. Baseline note: centaur repo untouched (verified `git status`; only pre-existing
   doc drift from 2026-07-11 unrelated to this work).
