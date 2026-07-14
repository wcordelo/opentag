# OpenTag 2.0 — Build Goal

> **Historical execution plan.** Phases A1–A5 are complete on the OpenTag 2.0
> branch. Use [PRODUCT.md](./PRODUCT.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> and [docs/extending.md](./docs/extending.md) for current behavior. Task lists
> below preserve the original acceptance criteria and delegation record.

**Objective:** Transform opentag's rudimentary single-buffered Slack bot into a polished, resilient AI assistant by porting centaur's mature chatbot UX patterns into Cloudflare-native code.

**You are the orchestrator.** Read SPEC.md (the full plan), then delegate implementation tasks to subagents. Use the Task tool — assign models based on task complexity. Review every subagent's output before accepting.

---

## House rules (never violate)

1. **Events API only.** No Socket Mode. No Railway. All Slack traffic enters `edge/src/worker.ts`.
2. **DO for all durability.** No in-memory state that must survive a Worker restart.
3. **Never post duplicate messages.** Every execute path carries an `executionId` dedup key. Every message carries a `forwardedMessageId`.
4. **50-block Slack limit.** No Block Kit message may exceed 50 blocks. Truncate + overflow gracefully.
5. **Rate-limit discipline.** `chat.update` is capped at ~1/sec per channel. The conflation layer (`conflate.ts`) is what makes incremental rendering viable — do not bypass it.
6. **HITL gates.** Before any external action (CF deploy, wrangler publish, Slack message to a real channel), pause and get user approval. Architectural surprises also gate.
7. **centaur untouched.** We borrow patterns from `~/Documents/centaur/`, never modify it.
8. **Typecheck must pass.** After each phase: `cd edge && npm run typecheck`. Fail = not done.
9. **Existing tests must pass.** `cd edge && npm test`. Do not break existing behaviour.

---

## Model assignment for subagents

When spawning Task subagents, match the model to the work:

| Work type | Model |
|---|---|
| Verbatim file port (conflate.ts, overrides.ts, stop-command.ts) | `claude-haiku-4-5-20251001` |
| Core implementation (stream() rewrite, SessionDO, render obligation) | `claude-sonnet-4-6` |
| Complex architecture / new DO design | `claude-sonnet-4-6` |
| Code review / independent verification pass | `claude-sonnet-4-6` |
| Anything touching wrangler.toml or DO registration | `claude-sonnet-4-6` |

---

## Phases and done criteria

Work through phases in order. Do not start A2 before A1's done criteria pass.

### Phase A1 — Streaming render + status
**Done when:**
- `edge/src/slack/conflate.ts` exists and its `conflateChatSdkStream` matches the centaur source logic
- `edge/src/slack/cloudflare-slack-adapter.ts` `stream()` method posts a placeholder immediately and updates it incrementally — NOT buffer-then-post
- A test or manual trace confirms the method calls `client.postMessage` once at start, then `client.updateMessage` at least once per distinct content chunk
- `edge/src/slack/web-api.ts` has `setStatus(args)` and `setTitle(args)` methods
- `edge/src/bot-engine.ts` calls `setStatus("Thinking…")` at turn start and `setStatus("")` at turn end
- `cd edge && npm run typecheck` passes
- `cd edge && npm test` passes

**Key files to read before starting A1:**
- `edge/src/slack/cloudflare-slack-adapter.ts` lines 418–434 (the bug)
- `~/Documents/centaur/services/slackbotv2/src/conflate.ts` (verbatim port)
- SPEC.md §2.1 (conflate), §3.3 (stream() replacement pattern)

**Subagent task split:**
1. Haiku agent: port `conflate.ts` verbatim + define `chunk-types.ts`
2. Sonnet agent: rewrite `stream()` in the adapter using conflation + incremental updates
3. Sonnet agent: wire `setStatus`/`setTitle` in web-api + bot-engine
4. Sonnet review agent: verify correctness of all three outputs, typecheck, test

### Phase A2 — Session DO + never-silent guarantee
**Done when:**
- `edge/src/store/session-event-do.ts` exists with SQLite events table and RPC methods: `create`, `execute`, `replay(afterEventId)`, `interrupt`, `appendEvent`
- `edge/src/store/conversation-state-do.ts` has `renderObligation` KV slot and alarm handler (`alarm()` method that replays events and posts fallback if obligation exists)
- `edge/src/slack/stop-command.ts` exists with `isSlackStopCommand()`
- `edge/src/worker.ts` calls `isSlackStopCommand()` before routing and, on match, interrupts the session + clears status
- `wrangler.toml` registers `SessionEventDO` as a Durable Object with alarm support
- `cd edge && npm run typecheck` passes
- `cd edge && npm test` passes

**Key files to read before starting A2:**
- `~/Documents/centaur/services/slackbotv2/src/stop-command.ts` (verbatim port)
- SPEC.md §3.1 (render obligation), §3.2 (SessionDO schema), §4.1 (what's new)
- `edge/src/store/conversation-state-do.ts` (extend this)
- `edge/src/store/durable-object-state-store.ts` (existing StateStore pattern)

**Subagent task split:**
1. Haiku agent: port `stop-command.ts` verbatim
2. Sonnet agent: build `session-event-do.ts` (SQLite schema + RPC methods)
3. Sonnet agent: extend `conversation-state-do.ts` with obligation + alarm handler
4. Sonnet agent: wire stop command in `worker.ts`; update `wrangler.toml`
5. Sonnet review agent: verify alarm semantics, dedup invariants, typecheck, test

### Phase A3 — Model/harness overrides
**Done when:**
- `edge/src/slack/overrides.ts` exists with `extractMessageOverrides()` covering `--model`, `--sonnet/--opus/--haiku` shortcuts, `-rsn <effort>` (drop `--amp`, `--bedrock`, `--meta` initially)
- `edge/src/store/conversation-state-do.ts` persists `model` and `harnessType` sticky per thread
- `edge/src/agent-turn.ts` calls `extractMessageOverrides(rawText)` and uses the returned `model` override
- `edge/src/tasks/runtime.ts` (or equivalent) accepts and passes the model to the container
- Flags are stripped from `cleanedText` before the agent sees them
- `cd edge && npm run typecheck` passes

**Key files:**
- `~/Documents/centaur/services/slackbotv2/src/overrides.ts` (port, trimmed)
- SPEC.md §2.2

**Subagent task split:**
1. Haiku agent: port `overrides.ts` (drop Amp/Bedrock/Meta, update model alias table)
2. Sonnet agent: wire overrides into agent-turn + runtime + DO thread state
3. Sonnet review agent: verify flag stripping doesn't corrupt user text; typecheck

### Phase A4 — Quick-action cards
**Done when:**
- `edge/src/slack/quick-card.ts` exists with `findQuickSiteUrls()` / `buildQuickDeployCard()` generalized for opentag URLs
- `edge/src/slack/quick-actions.ts` decodes action payloads and routes them as synthetic agent turns (authored by the clicking user)
- `edge/src/worker.ts` interactions handler dispatches `quick_*` action IDs to the quick-actions handler
- At least one existing card in `edge/src/components/cards.ts` gets a "Retry" or "Re-run" button wired up
- `cd edge && npm run typecheck` passes

**Key files:**
- `~/Documents/centaur/services/slackbotv2/src/quick-card.ts` (port)
- SPEC.md §2.3, §3.4

### Phase A5 — Claude Code harness container (defer until A1–A4 are solid)
Per SPEC.md §4.4 and §5 Phase A5. Spawn when explicitly requested.

---

## Workflow protocol

1. Read SPEC.md and this file before doing anything else.
2. Identify which phase to start (A1 unless otherwise directed).
3. Read the "key files" listed for that phase.
4. Spawn implementation subagents (one per logical unit of work).
5. After all implementation subagents complete, spawn one review subagent with the prompt: "Review the changes just made for correctness, type safety, and adherence to the house rules in GOAL.md. Run `cd edge && npm run typecheck` and `npm test`. Report what passes, what fails, and what to fix."
6. Fix review findings. If the fix is non-trivial, spawn another implementation subagent.
7. Mark the phase done when all done criteria pass. Update `implementation-notes.md` with decisions and deviations.
8. Gate before starting A2: confirm with the user that A1 looks good in Slack.

---

## Context

- Centaur repo: `~/Documents/centaur/` — source of patterns; never modify
- Opentag repo: `~/Documents/opentag/` — target; all edits here
- Full spec: `~/Documents/opentag/SPEC.md`
- Architecture analysis: `~/Documents/opentag/ARCHITECTURE-ANALYSIS.md`
- Existing decisions: `~/Documents/opentag/DECISIONS.md`
- Agents guide: `~/Documents/opentag/AGENTS.md`
