# Implementation Notes

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
