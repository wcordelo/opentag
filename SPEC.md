# OpenTag 2.0 — Centaur UX Port: SPEC

> **Historical implementation specification.** A1–A5 are implemented and later
> reliability/security review strengthened several designs. Current truth is
> [ARCHITECTURE.md](./ARCHITECTURE.md), locked choices are
> [DECISIONS.md](./DECISIONS.md), and the realized Centaur comparison is
> [docs/centaur-port.md](./docs/centaur-port.md).

**Date:** 2026-07-12  
**Decision:** Port centaur's chatbot UX into opentag (Option A). Do not move centaur off K8s (Option B).  
**Goal:** Transform opentag's rudimentary single-buffered bot into a polished, resilient Slack AI assistant by pulling the mature UX patterns out of centaur's `slackbotv2/` service and `packages/rendering/` and adapting them to run on Cloudflare Workers + Durable Objects.  
**Full analysis:** `ARCHITECTURE-ANALYSIS.md`

---

## 1. What NOT to Port

These centaur components are K8s-specific and have no place in opentag:

| Component | Reason |
|---|---|
| `services/api-rs/` (~60.4k LOC Rust) | Sandbox backend IS the K8s API (4,567 LOC of CRD bindings). The session contract it exposes is what we need, not the implementation — we build a lean SessionDO instead (~1.5–3k LOC TS). |
| `services/console/` (Rails, ~31.8k LOC) | Web session viewer. Can be replaced with a read-only Worker page over the session DO's event log if needed later. |
| `services/iron-proxy/` | MITM egress proxy with sidecar + NetworkPolicy model. No CF equivalent. Documented trade-off: real credentials in Worker secrets, not injected. |
| `contrib/chart/` (Helm) | K8s deployment. Opentag deploys via Wrangler. |
| `services/api-rs/k8s/` + agent-sandbox controller | CRD lifecycle controller. CF Containers are spawned directly from DOs — no orchestration API needed. |
| Postgres/ParadeDB | 41 sqlx migrations, `pg_search`, `pg_cron` — D1 cannot replace. Session state goes in DO SQLite instead. |
| repo-cache DaemonSet | hostPath/RWX mounts don't exist on CF. Use clone-per-session or R2 sync for repos instead. |
| `services/sandbox/install_tool_shims.py` | Tool shim installation assumes repo-cache mounts. CF Containers bake tools into the image directly. |
| warm-pool / capacity manager | No CF equivalent as a first-class primitive. Start without — warm instances at cost if needed later. |
| VictoriaLogs / VictoriaMetrics deployment | K8s infra. CF Workers Analytics + structured logs are the replacement. |

---

## 2. Port Verbatim (zero runtime coupling)

These files are pure TypeScript / regex logic with no Node or K8s dependency. Copy them into opentag and adapt at the type import level only.

### 2.1 `conflate.ts`
**Source:** `centaur/services/slackbotv2/src/conflate.ts` (110 LOC)  
**Target:** `edge/src/slack/conflate.ts`  
**Changes needed:** Replace the `ChatSDKStreamChunk` import from `@centaur/rendering` with opentag's own chunk type (or a locally defined equivalent covering `markdown_text | task_update | plan_update`). The async-iterator logic is Workers-compatible as-is.  
**What it does:** Drains a high-frequency event source eagerly into a pending snapshot so Slack API calls are bounded by distinct cards, not event count. Markdown deltas concatenate; `task_update` merges per-id newest-wins; `plan_update` keeps latest.

```typescript
// Key invariant from the file's jsdoc — preserve this:
// "Slack rendering pays one rate-limited API call per chunk, while a busy
//  execution can emit tens of thousands of chunks."
```

### 2.2 `overrides.ts`
**Source:** `centaur/services/slackbotv2/src/overrides.ts` (165 LOC)  
**Target:** `edge/src/slack/overrides.ts`  
**Changes needed:** Drop `amp` from `HARNESS_FLAGS` (opentag doesn't run Amp). Drop `--bedrock`/`--meta` provider flags initially (add back when a second harness is live). Keep `--model`, `--fable/--opus/--sonnet/--haiku` aliases, and `-rsn` reasoning effort. Model alias table: update `fable: 'claude-fable-5'` etc. to whatever current model IDs opentag targets.  
**What it does:** Parses inline flag directives from Slack message text before the agent sees it. Returns `{ cleanedText, harnessType?, model?, provider?, reasoning? }`. Flags are stripped from the prompt and persist sticky at thread level.

### 2.3 `quick-card.ts`
**Source:** `centaur/services/slackbotv2/src/quick-card.ts` (~97 LOC)  
**Target:** `edge/src/slack/quick-card.ts`  
**Changes needed:** Remove the Quick site domain concept; generalize to opentag's output URLs (research report URLs, artifact URLs, etc.), or keep the pattern as-is and point `QUICK_BASE_DOMAIN` at opentag's artifact domain. Replace `chat` SDK imports with opentag's Block Kit builder.  
**What it does:** Scans final agent messages for URLs matching a base domain, builds interactive Block Kit cards with Re-generate / View files / Delete buttons. Each button's `value` carries a JSON `SiteRef` so the action handler knows what to act on.

### 2.4 `stop-command.ts`
**Source:** `centaur/services/slackbotv2/src/stop-command.ts` (27 LOC)  
**Target:** `edge/src/slack/stop-command.ts`  
**Changes needed:** None. The regex handles Slack mention token normalization and covers natural-language variants ("please cancel this", "kill it now", etc.).  
**What it does:** `isSlackStopCommand(message)` — returns true if the message is a stop/cancel intent. Call before routing to the bot engine; on match, interrupt the running session and clear the render obligation.

### 2.5 `console-session-link.ts` (pattern)
**Source:** `centaur/services/slackbotv2/src/console-session-link.ts` (125 LOC)  
**Target:** Inline into `edge/src/slack/session-link.ts`  
**Changes needed:** The Rails console URL becomes opentag's admin URL (or just a direct link to the DO's event log via a Worker endpoint). Model/harness info can be pulled from the session DO's thread state.  
**What it does:** On the first assistant message in a thread, appends a Slack context block: "Open in console · claude-sonnet-4-6 · Claude Code". Cheap UX win, zero infra dependency.

### 2.6 Thread dedup + idempotency state shape (from `SlackbotV2ThreadState`)
**Source:** `centaur/services/slackbotv2/src/types.ts` + `index.ts`  
**Target:** Add fields to `edge/src/store/conversation-state-do.ts`  
**Fields to add:**
```typescript
forwardedMessageIds: Set<string>   // message-level dedup, cap at 1,000
executedMessageIds: Set<string>    // execute idempotency
harnessType?: string               // sticky thread harness
model?: string                     // sticky thread model
provider?: string                  // sticky provider
lastExecutionId?: string           // for render obligation linkage
```

### 2.7 `SYSTEM_PROMPT.md` — behavioral sections to lift verbatim

The following sections from `centaur/services/sandbox/SYSTEM_PROMPT.md` apply to opentag's CF Container agent and should be adopted immediately (zero infra dependency — pure prompt engineering):

- **[Writing Quality Gate]** — brevity gates, lead-with-answer, no chatbot boilerplate, concrete claims. Copy exactly.
- **[User Interaction]** — status-first answers, partial-artifact delivery on blocked steps. Copy exactly.
- **[GitHub PR Attribution]** — `Prompted by:` line in PR bodies. Copy exactly; use `[Requester Context]` block (already injected in `agent-turn.ts`).
- **[Container Lifecycle]** — ephemeral container rules, push WIP before idle timeout, upload artifacts via Slack tool not local paths. Adapt: replace K8s refs with "your CF Container may be recycled between turns if idle."
- **[Python policy]** — uv-only. Copy exactly.
- **[Rust policy]** — nightly for fmt/clippy. Copy exactly.
- **[Parallel tool calls]** — issue independent lookups in the same turn. Copy exactly.
- **[User-visible artifact verification]** — verify the actual surface before claiming done. Copy exactly.
- **[Format complaints are correction signals]** — if user says format is wrong, switch medium on next turn. Copy exactly.

---

## 3. Port with CF Adaptation

These centaur patterns need to be rewritten for CF primitives, but the *logic and contracts* port directly.

### 3.1 Render obligations → DO alarm recovery
**Source:** `centaur/services/slackbotv2/src/index.ts:1426–1960`  
**Target:** New file `edge/src/slack/render-obligation-do.ts` (or extend `conversation-state-do.ts`)

Centaur's approach: persist a `renderObligation` row to Postgres, index it under `slackbotv2:render:index`, and on pod startup scan the index to recover crashed threads. Lease refresh keeps live renders and recovery from double-posting.

CF adaptation (simpler, stronger guarantees):
```
On obligation write:
  DO.storage.put('renderObligation', { executionId, afterEventId, messageRef })
  DO.storage.setAlarm(Date.now() + RENDER_TIMEOUT_MS)   // alarm IS the recovery sweep

On render completion:
  DO.storage.delete('renderObligation')
  DO.storage.deleteAlarm()

On alarm fire (alarm()):
  const ob = await DO.storage.get('renderObligation')
  if (!ob) return  // already completed
  // replay events from afterEventId → reconstruct final answer
  // post as new message if streamed message was lost
  // on success: delete obligation
```

The per-thread DO is the lease — no concurrent recovery from multiple pods can happen; the DO's single-threaded execution model gives isolation for free. No startup scan needed. Estimate: ~150 LOC vs centaur's ~500 LOC.

**Render outcome taxonomy** (copy centaur's naming):
- `streamed` — live render completed cleanly
- `fallback_sent` — alarm fired, reconstructed answer posted
- `answer_visible` — either of the above reached the user
- `error_visible` — error card posted (agent failed, quota, etc.)
- `failed_size_limit` — response exceeded Slack block/char limits

### 3.2 Session / event log → SessionDO
**Source:** `centaur/services/api-rs/` (contract only — not the implementation)  
**Target:** New file `edge/src/store/session-event-do.ts`

The contract opentag needs from api-rs:
- `POST /session/{thread_key}` — create (idempotent); return `{ sessionId }`. 409 → restart on harness mismatch.
- `POST /session/{id}/execute` — idempotent execute with `executionId`; `inputLines` as opaque NDJSON.
- `GET /session/{id}/events?after_event_id=N` — replayable SSE stream of session events.
- `POST /session/{id}/interrupt` — cancel running execution.

CF implementation: one `SessionEventDO` class with SQLite:
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,      -- 'input' | 'output' | 'error' | 'done'
  payload TEXT NOT NULL,   -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX events_execution ON events(execution_id, id);
```

Plus DO KV for:
```
session:created    → { sessionId, harnessType, model, threadKey }
session:executing  → { executionId, startedAt }   -- cleared on done/interrupt
session:interrupted → boolean
```

RPC methods (via DO stubs, not HTTP): `create`, `execute`, `replay(afterEventId)`, `interrupt`, `appendEvent`. Estimate: ~800–1,200 LOC including the SQLite schema and replay cursor logic. Keep it strictly at this surface — no warm pools, no capacity management, no ETL.

### 3.3 Incremental Slack renderer (replacing `cloudflare-slack-adapter.ts:stream()`)
**Source:** `centaur/services/slackbotv2/src/index.ts` streaming render + `conflate.ts`  
**Target:** Rewrite `cloudflare-slack-adapter.ts:418–434`

The current bug:
```typescript
// CURRENT (buffering — the root cause of slow UX):
async stream(target, chunks): Promise<MessageRef> {
  let acc = "";
  for await (const c of chunks) acc += c;   // ← waits for entire response
  const r = await this.client.postMessage({ text: acc || "(empty)" });
  return { id: r.ts, ... };
}
```

Replacement pattern:
```typescript
async stream(target, chunks): Promise<MessageRef> {
  // 1. Post a placeholder "thinking" message immediately
  const placeholder = await this.client.postMessage({
    channel: target.channel, thread_ts: target.threadTs,
    text: "…",
  });
  let messageTs = placeholder.ts;

  // 2. Drain via conflation
  const conflated = conflateChatSdkStream(chunks);
  let acc = "";
  let lastUpdateAt = 0;
  const MIN_UPDATE_INTERVAL_MS = 800;  // ~1.25 updates/sec max, Slack rate limit headroom

  for await (const chunk of conflated) {
    if (chunk.type === 'markdown_text') acc += chunk.text;
    // task_update / plan_update → Block Kit cards via @centaur/rendering equivalents

    const now = Date.now();
    if (now - lastUpdateAt >= MIN_UPDATE_INTERVAL_MS) {
      await this.client.updateMessage({
        channel: target.channel, ts: messageTs,
        text: acc || "…",
        blocks: buildBlocks(acc, pendingCards),
      });
      lastUpdateAt = now;
    }
  }

  // 3. Final update with complete content
  await this.client.updateMessage({ ... final state ... });
  return { id: messageTs, channel: target.channel, ts: messageTs };
}
```

**Key constraints from centaur experience:**
- Block Kit hard limit: 50 blocks per message. Truncate gracefully; overflow to a second message.
- Block content: 3,000 chars per text block; fallback text: 35k chars.
- Task detail field: truncate to 500 chars.
- Rate limits: `chat.update` at ~1/sec per channel. Conflation absorbs burst; MIN_UPDATE_INTERVAL enforces headroom.
- Use `chat.update` not `chat.postMessage` for updates — one message per turn, edited in place.

### 3.4 Quick-actions (buttons → synthetic agent turns)
**Source:** `centaur/services/slackbotv2/src/quick-actions.ts`  
**Target:** `edge/src/slack/quick-actions.ts` + wire into `edge/src/worker.ts:/slack/interactions`

The centaur pattern: button click payloads decode a `QuickSiteRef`, then `handleQuickAction` constructs a synthetic Slack message object authored by the clicking user and routes it through the normal agent-turn pipeline. The result: button clicks inherit dedup, requester identity, and the turn lock — no parallel button-handling path.

Opentag adaptation:
```typescript
// In worker.ts interactions handler:
const payload = JSON.parse(body.payload);
if (payload.actions?.[0]?.action_id?.startsWith('quick_')) {
  const action = payload.actions[0];
  const siteRef = JSON.parse(action.value);
  const syntheticText = buildQuickActionPrompt(action.action_id, siteRef);
  const syntheticUser = payload.user.id;  // the clicking user, not the original requester

  // Route exactly like a new user message in this thread
  await runBundledAgentTurn(env, {
    channelId: payload.channel.id,
    threadTs: payload.message.thread_ts ?? payload.message.ts,
    userId: syntheticUser,
    text: syntheticText,
  });
}
```

Apply to opentag's existing cards in `edge/src/components/cards.ts`:
- Issue cards → "Retry search", "Create follow-up ticket"
- Incident cards → "Page on-call", "Open postmortem"
- Research cards → "Dig deeper", "Export as doc"

### 3.5 Assistant status
**Source:** `centaur/services/slackbotv2/src/index.ts:3071–3210`  
**Target:** `edge/src/slack/web-api.ts` (already has `setStatus`) + `edge/src/bot-engine.ts`

`assistant.threads.setStatus` and `assistant.threads.setTitle` are plain Slack Web API calls. Replace the hourglass `addReaction` with status updates:

```typescript
// Start of turn:
await slack.setStatus({ channel, thread_ts, status: "Thinking…" });

// During long turns (if activity_summary events come from the agent):
await slack.setStatus({ channel, thread_ts, status: truncate(activitySummary, 50) });

// On completion:
await slack.setStatus({ channel, thread_ts, status: "" });  // clears status

// Thread title (first turn only):
await slack.setTitle({ channel, thread_ts, title: truncate(firstUserMessage, 100) });
```

**Prerequisite:** Verify opentag's Slack app has `assistant:write` scope and is configured as an "Assistant" app in the Slack App Manifest. This is the one external unknown — validate before implementing A1.

### 3.6 Harness restart with transcript re-feed
**Source:** `centaur/services/slackbotv2/src/session-api.ts:582` (`harnessRestartPreamble`)  
**Target:** `edge/src/agent-turn.ts`

When a `--claude` flag appears on a thread that was running a different harness (or vice versa), the old session state is invalid. Centaur's pattern: collect the full Slack thread transcript, truncate to 24k chars from the most recent end, and feed it as `[Transcript]` context into the new session creation. Opentag already re-injects Slack history (`agent-turn.ts:398–417`) as a workaround for isolate-local state loss — this formalizes that pattern as the harness-switch path and makes it the documented behavior, not a workaround.

---

## 4. Build New (no centaur counterpart, CF-native)

### 4.1 `SessionEventDO`
See §3.2. This is the mini-api-rs: per-thread event log with replay, idempotent execute, and interrupt. Completely new code; derives its *contract* from centaur api-rs but shares no implementation.

### 4.2 Render obligation storage in `ConversationStateDO`
See §3.1. Extend the existing DO to store the obligation + set/clear alarms. New code; derives its pattern from centaur's Postgres-backed approach but is simpler due to DO single-threading.

### 4.3 Metrics / delivery accounting
Centaur's `metrics.ts` (377 LOC) emits ~30 Prometheus metrics. For opentag, use CF Workers Analytics Engine or structured logs. Minimum counters to wire:
- `turn_started`, `turn_completed`, `turn_failed`
- `streamed` (live render), `fallback_sent` (alarm recovery)
- `answer_visible`, `error_visible`, `failed_size_limit`
- `stop_command_received`

Not a full Prometheus exporter, but enough to monitor delivery health.

### 4.4 Claude Code in a CF Container (Phase A5)
Centaur's sandbox is Ubuntu 24.04 with `claude-code` + `codex` CLIs, `crates/harness-server` as a Rust wrapper behind the "Codex App Server V2 / blocks" wire protocol, and `centaur_tool_host.py` (106 LOC) as the stdin/stdout JSON bridge.

For opentag's CF Container:
- Extend `edge/workers/sandbox/` scaffold (already exists)
- Base image: Ubuntu 22.04+ with Node 20+, `claude-code` CLI, ripgrep, jq, git, uv
- Wire protocol: implement a minimal HTTP shim that accepts a session turn, spawns `claude-code` in non-interactive mode, and streams its output as session events to the SessionDO
- Repo access: `git clone --depth=1` per session; cache on R2 with a freshness TTL for large repos
- Adopt the brevity/attribution behavioral contract from `SYSTEM_PROMPT.md` (§2.7)

The `centaur_tool_host.py` (106 LOC) pattern is worth copying: keep the Container's own surface small and delegate to tool CLIs that can be updated by redeploying code, not rebuilding the image.

---

## 5. Phase-by-Phase Plan

### Phase A1 — Streaming render + status (felt upgrade, ~1–2 weeks)
**Goal:** Users see the bot's response building in real time, not a single post after a long wait.

Files changed:
1. **New** `edge/src/slack/conflate.ts` — port verbatim from centaur, adjust imports
2. **Rewrite** `edge/src/slack/cloudflare-slack-adapter.ts:418–434` — replace `stream()` with incremental render (see §3.3)
3. **New** `edge/src/slack/chunk-types.ts` — define `ChatSDKChunk` union (`markdown_text | task_update | plan_update`) to replace the `@centaur/rendering` import in conflate.ts
4. **Extend** `edge/src/slack/web-api.ts` — add `setTitle()` if missing; ensure `setStatus()` accepts empty string
5. **Update** `edge/src/bot-engine.ts` — replace `addReaction('hourglass')` with `setStatus("Thinking…")` at turn start; `setStatus("")` at turn end
6. **Update** `edge/src/agent-turn.ts` — call `setTitle()` on first turn in a thread

**HITL gate:** Validate `assistant:write` scope and "Assistant" app type in Slack manifest before writing a line of streaming code. If the scope isn't available, fall back to `chat.update`-based rendering (same conflation logic, just no status API).

**Definition of done:** A multi-sentence response appears incrementally in Slack; the status indicator shows "Thinking…" and clears on completion; the turn still works if conflation yields a single chunk.

### Phase A2 — Session DO + never-silent guarantee (~2–3 weeks)
**Goal:** No turn ever produces silence. Crash recovery is automatic.

Files changed / created:
1. **New** `edge/src/store/session-event-do.ts` — `SessionEventDO` with SQLite events table, `create/execute/replay/interrupt/appendEvent` RPC (see §3.2)
2. **Extend** `edge/src/store/conversation-state-do.ts` — add `renderObligation` KV slot + alarm handler (see §3.1)
3. **New** `edge/src/slack/stop-command.ts` — port verbatim (see §2.4)
4. **Update** `edge/src/worker.ts` — call `isSlackStopCommand()` before routing to bot-engine; on match, call `sessionDO.interrupt()`, clear render obligation, clear status
5. **Update** `edge/src/bot-engine.ts` — write obligation before executing; clear on completion; on catch, ensure obligation remains for alarm recovery
6. **Update** `wrangler.toml` — register `SessionEventDO` as a Durable Object; set alarm handler

**Definition of done:** Kill the Worker mid-turn (via Wrangler tail); the alarm fires within the configured timeout; the thread receives the fallback final answer derived from the last known event snapshot.

### Phase A3 — Model/harness overrides (~3–5 days)
**Goal:** Users can type `--sonnet` or `--model claude-opus-4-8` to switch models inline.

Files changed / created:
1. **New** `edge/src/slack/overrides.ts` — port from centaur, trim harness table to what opentag supports (see §2.2)
2. **Update** `edge/src/agent-turn.ts` — call `extractMessageOverrides(rawText)` early; store `model/harnessType` in thread state; pass effective model to the container
3. **Extend** `edge/src/store/conversation-state-do.ts` — persist `harnessType`, `model`, `provider` sticky per thread
4. **Update** `edge/src/tasks/runtime.ts` — accept `model` override; pass to Claude Code via `CLAUDE_MODEL` or `--model` CLI arg

**Definition of done:** `--opus` in a thread turns it to Opus; the next turn in the same thread uses Opus without re-typing the flag; a new thread starts with the default model.

### Phase A4 — Quick-action cards + attachment hardening (~1–2 weeks)
**Goal:** Interactive cards on research outputs; attachment handling that doesn't break on large files.

Files changed / created:
1. **New** `edge/src/slack/quick-card.ts` — port from centaur (see §2.3)
2. **New** `edge/src/slack/quick-actions.ts` — synthetic turn routing (see §3.4)
3. **Update** `edge/src/worker.ts:/slack/interactions` — decode quick action payloads; route as synthetic turns
4. **Update** `edge/src/components/cards.ts` — add quick-action buttons to research result cards
5. **Update** `edge/src/slack/download-files.ts` — add size-tier staging; late-file repair (set a 15s idle timeout; re-attach files that arrive after the initial message)

**Definition of done:** A research result card shows "Retry" and "Export" buttons; clicking Retry posts a new turn as the clicking user; large file attachments don't exceed Slack or Worker limits.

### Phase A5 — Claude Code harness container (~3–4 weeks)
**Goal:** A real coding harness inside a CF Container emitting session events; git clone per session; PR attribution via `[Requester Context]`.

Files changed / created:
1. **Extend** `edge/workers/sandbox/` — add HTTP server that accepts `{ sessionId, executionId, inputLines, model }` and streams events back to SessionDO
2. **New Dockerfile** for the harness container — Ubuntu 22.04, Node 20, `claude-code` CLI pinned version, ripgrep, jq, git, uv, fd
3. **New** `services/harness/tool-host.ts` — minimal stdin/stdout JSON loop (port of `centaur_tool_host.py` in TypeScript) that shells out to tool CLIs
4. **Adopt** `SYSTEM_PROMPT.md` behavioral sections (§2.7) as the agent's system prompt in `lib/triage-agent.ts` or the harness container's prompt
5. **Update** `edge/src/agent-turn.ts` — inject `[Requester Context]` block with Slack display name + optional GitHub handle extracted from Slack profile `github_url` or `github` field

**Definition of done:** A coding request (`make a script to…`) results in real code committed to a temp branch; PR body contains `Prompted by: @<handle>`.

---

## 6. Centaur Wisdom — Patterns to Borrow (Not Code)

These are design decisions centaur made the hard way. Adopt them without rebuilding centaur:

**The "buttons are just user turns" principle.** Quick-action buttons don't have a separate state machine. They produce synthetic messages authored by the clicking user and enter the normal message pipeline. This means they inherit dedup, rate limiting, turn locks, requester identity, and tool permission checks for free. Never build a parallel button-execution path.

**The "never silent" delivery contract.** Every turn must resolve to one of the named outcomes: `streamed`, `fallback_sent`, `error_visible`, `failed_size_limit`. If none of those happened, the system failed silently — which is always wrong. Build the alarm-recovery path before you build anything else in A2; the happy path is easy, the crash path is what matters.

**Restart semantics on harness change.** When a user changes the harness (or model in a significant way), don't try to continue the old session's state. Acknowledge the change, restart the session, and re-feed the Slack thread transcript as context. Users understand this; silent model confusion is worse.

**The idempotency-key discipline.** Every execute call carries an `executionId`; every message has a `forwardedMessageId`. Slack redelivers events aggressively on its 3s-timeout model. Without these keys, a slow turn gets executed twice. The existing `durable-choice.ts` in opentag already thinks in these terms — apply the same discipline to every turn.

**Conflation is about respecting the consumer.** The Slack API is rate-limited. Without conflation, a 10-minute research run with thousands of internal events would produce thousands of update calls, most of which would fail or be rate-limited. Conflation collapses intermediate states: the consumer only processes what it can, and the source runs as fast as it wants. This is the single highest-leverage change in A1.

**The dedup cap.** `forwardedMessageIds` and `executedMessageIds` are capped at 1,000 entries. Without a cap, long-lived threads accumulate unbounded state. With a cap, very old duplicate messages re-execute — acceptable because duplicate execution of a message that's 1,000 messages old is statistically impossible in practice.

**Truncate everything that touches Slack's limits.** Block Kit: 50 blocks/message. Text blocks: 3,000 chars. Fallback text: 35k chars. Task details: 500 chars. Assistant status: 50 chars. Thread title: 100 chars. When in doubt, truncate and add `…`. Centaur spent considerable time hitting these limits in production; the values above come from that experience.

---

## 7. Gap Reference Table

Quick lookup: each gap from the architecture analysis mapped to its fix and the phase that addresses it.

| Gap | Root cause in opentag | Fix | Phase |
|---|---|---|---|
| No live streaming | `cloudflare-slack-adapter.ts:418` buffers entire response | Rewrite `stream()` with conflation + incremental `chat.update` | A1 |
| No delivery guarantee | Unhandled crashes → silence or generic error card | Render obligation in ConversationStateDO + alarm recovery | A2 |
| No progress visibility | Only hourglass reaction for multi-minute turns | Assistant status API + task_update cards | A1 |
| No stop/interrupt | No interrupt path anywhere | `isSlackStopCommand()` → `sessionDO.interrupt()` | A2 |
| No model/harness selection | `AGENT_MODEL` env var only | `overrides.ts` + sticky thread state | A3 |
| Isolate-local agent state | `agentsByConversation` is in-memory Map | SessionEventDO with replay from afterEventId | A2 |
| No real coding harness | Single triage prompt + MCP tools; no repo, no git | CF Container with Claude Code headless + clone-per-session | A5 |
| Thin attachment handling | No size tiers, no late-file repair | Size-tier staging + 15s idle repair | A4 |
| No interactive follow-up cards | Buttons only resolve HITL waits | Quick-action cards → synthetic turns | A4 |
| No observability | `console.error` only | Structured logs + CF Analytics Engine counters | A2 |
| No session viewer / console link | — | Context block on first assistant message | A1 (low-effort) |
| No requester→GitHub identity | Email/timezone only | Slack profile field extraction + `[Requester Context]` block | A5 |

---

## 8. File Tree — Net New Files

```
edge/src/slack/
  conflate.ts               (A1 — verbatim port)
  overrides.ts              (A3 — verbatim port, trimmed)
  stop-command.ts           (A2 — verbatim port)
  quick-card.ts             (A4 — verbatim port, generalized)
  quick-actions.ts          (A4 — adapted pattern)
  session-link.ts           (A1 — console-session-link pattern)
  chunk-types.ts            (A1 — local ChatSDKChunk type)

edge/src/store/
  session-event-do.ts       (A2 — new, mini api-rs contract)

edge/workers/sandbox/
  harness-server.ts         (A5 — HTTP shim for Claude Code in container)
  tool-host.ts              (A5 — stdin/stdout JSON bridge, port of centaur_tool_host.py)

containers/harness/
  Dockerfile                (A5 — Ubuntu 22.04 + claude-code + tooling)
  SYSTEM_PROMPT.md          (A5 — adapted from centaur/services/sandbox/SYSTEM_PROMPT.md)
```

Files substantially modified:
```
edge/src/slack/cloudflare-slack-adapter.ts   (A1 — rewrite stream())
edge/src/store/conversation-state-do.ts      (A2 — add obligation + alarm)
edge/src/bot-engine.ts                       (A1/A2 — status, stop, obligation)
edge/src/agent-turn.ts                       (A3/A5 — overrides, requester context)
edge/src/worker.ts                           (A2/A4 — stop routing, interaction handler)
edge/src/tasks/runtime.ts                    (A3 — model passthrough to container)
wrangler.toml                                (A2 — register SessionEventDO, alarm)
```

---

## 9. Out of Scope (for now)

- Multi-workspace / multi-tenant session isolation — current single-workspace model is fine
- Warm container pools — cold start on CF Containers is acceptable at team scale
- Full Prometheus metrics exporter — structured logs + CF Analytics Engine is sufficient
- `iron-proxy` equivalent — real keys in Worker secrets; documented trade-off
- Web console (Rails equivalent) — DO event log is readable directly; full UI is a later project
- Amp / Codex harnesses — implement Claude Code first; flag syntax reserved but unimplemented
- PR automation end-to-end — attribution and clone-per-session land in A5; auto-merge is a later track

---

## 10. Decision Log

| Decision | Rationale |
|---|---|
| Port centaur UX into opentag, not the reverse | Option B has four hard walls (ParadeDB, K8s API bindings, iron-proxy, repo-cache) and zero UX payoff. Option A produces user-visible improvement in weeks. |
| SessionEventDO replaces api-rs contract | 1.5–3k LOC TS vs 60.4k LOC Rust; opentag doesn't need warm pools, capacity manager, or multi-tenant perms that make api-rs large. |
| DO alarm as recovery sweep | Strictly stronger than centaur's startup-scan: per-thread DO is already the lease; alarm fires exactly once per obligation; no pod-startup coordination needed. |
| chat.update-based streaming (not assistant streaming API) | Fallback-safe: chat.update works in all Slack surfaces; assistant streaming APIs require specific app configuration. Validate assistant API availability in A1 gate. |
| Clone-per-session for repos (not repo-cache) | No hostPath mounts on CF; R2-backed cache as a later optimization. Acceptable latency at team scale. |
| Keep centaur running as-is | centaur is production; we are building opentag in parallel. No centaur code is modified. |
