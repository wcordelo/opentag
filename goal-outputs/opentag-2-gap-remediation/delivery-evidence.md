# Delivery and durability remediation evidence

Date: 2026-07-14

Scope: C2, C4, H4, H5, H7, M6, M7, L3, plus the root-requested M8 and L2/Stop-continuation store integrations. No Worker, Container, Slack API, or other external system was deployed or mutated.

## Source resolutions

- C2 — `active_turns` and `render_obligations` now durably store the reserved live `client_msg_id`, reconciliation state, and confirmed Slack `ts`. Exact CAS APIs confirm a post or mark an authoritative bounded lookup absent. Recovery defers while identity is ambiguous, updates a confirmed live `ts`, and only creates a fallback for absent/legacy rows. `findMessageByClientMessageId` provides the bounded exact thread lookup primitive.
- C4 — replay is losslessly split into Slack-safe pages. The obligation is retained throughout egress; fast definitive retries are bounded and exhaustion becomes a slow retained dead letter rather than deletion. Ambiguous/rate-limited attempts preserve ownership and stable per-page IDs.
- H4 — the Slack client honors HTTP 429 `Retry-After` with bounded identical-request retries. `SlackChannelRateScheduler` serializes and spaces writes per channel when shared by the composition root. Recovery also honors 429 delay without consuming definitive-failure budget.
- H5 — SessionEventDO receives a mandatory `transactionSync` runner. Execute row plus all input events, done event plus terminal timestamp, and cancellation tombstone plus done/terminal transition are each one crash-atomic SQLite transaction. Fault-injection tests prove rollback.
- H7 — `buildSlackMessagePages` preserves arbitrary output across deterministic <=50-block continuation pages; each block is <=3,000 characters and fallback text <=35,000.
- M6 — the full outcome type includes `streamed`, `answer_visible`, `fallback_sent`, `error_visible`, and `failed_size_limit`; recovery emits confirmed outcomes to logs and Analytics Engine. `DELIVERY_METRICS` is required in `Env` and bound in both bot/dev Wrangler configs. Both DOs expose real SQLite probes and `probeDurabilityHealth` performs bounded binding checks.
- M7 — `SESSION_EVENTS` and `forwardedMessageId` are required at the type boundary. SessionEventDO rejects blank/missing forwarded IDs at runtime instead of accepting without durable session ownership.
- L3 — `compact()` deletes only terminal history older than retention and at/below a caller-proven safe replay cursor, retains active and the newest 256 terminal executions by default, and bounds old cancellation tombstones.
- M8 — `session_handoffs` persists exact execution/forwarded-message/input identity. Alarm claims use tokens, stale claims recover, accepted/duplicate/cancelled results are terminal, transient/busy failures retry three times, and exhausted evidence remains queryable for 24 hours.
- L2/Stop continuation — comments now identify SQL executions/events/cancellation tombstones as authoritative and KV creation data as compatibility metadata. Alarm-resumed Stop clears root-thread assistant status idempotently before the visible acknowledgement.

## Regression coverage

- Live identity reservation -> confirmed `ts` propagation into both active turn and obligation.
- Lossless 200,000-character page reconstruction and large replay recovery.
- Retained dead letter after three definitive failures.
- HTTP 429 `Retry-After`, identical form replay, per-channel serialization, and client-id reconciliation.
- Execute/done injected SQLite faults roll back all partial rows.
- Cursor-safe compaction preserves recent dedup.
- Exact handoff token CAS, bounded exhaustion, and alarm resumption.
- Real durability health succeeds only when both bindings answer.
- Alarm-resumed Stop status clear ordering.

Verification:

- `cd edge && npm run typecheck` — PASS.
- Focused delivery/store suite (7 files, 89 tests) — PASS.
- `cd edge && npm test` — 585 passed; remaining failures at the recorded run were cross-owner live-render/Stop integration assertions (`slack-stream` still expected truncation; H1 exact quiescence test fakes rejected Stop). These were reported to the root owner for final integration and rerun.

## Required cross-owner integrations

1. Before pre-admission, derive a stable UUID-format live client id from the exact execution id and set `ActiveTurnRecord.liveClientMessageId`. The first placeholder `chat.postMessage` must use it. On a returned `ts`, call `activeTurn.confirmLiveMessage`. A duplicate response without `ts` must use `findMessageByClientMessageId`; call `confirmLiveMessage` when found or `markLiveMessageAbsent` only after a definitive bounded lookup.
2. The Channels live renderer must use `buildSlackMessagePages` and stable per-page client ids for overflow; the compatibility one-page block helper is not a complete-output renderer.
3. Construct every Slack client/render transport with one shared `SlackChannelRateScheduler` so independent streams in the same channel do not bypass the discipline.
4. At confirmed normal transitions, emit `streamed`, `answer_visible`, and `failed_size_limit` to `DELIVERY_METRICS`. Recovery already emits its confirmed outcomes.
5. `/health` must call `probeDurabilityHealth` and return non-success when either required DO binding errors or times out.
6. Turn lifecycle should use `sessionHandoff.start/get/clear`: continue to model execution only after exact accepted/duplicate state, surface cancelled, and show a small visible retry error after exhausted. Never replay the model/tool invocation itself.

## Primary files

`edge/src/store/{schema,active-turn-engine,active-turn-types,conversation-state-do,durable-object-state-store,session-event-do,session-handoff-engine,state-store-contract}.ts`, `edge/src/slack/{stream-render,web-api}.ts`, `edge/src/{env,health}.ts`, Wrangler configs, and focused tests under `edge/test/`.
