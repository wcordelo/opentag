# Ingress / control / UX remediation evidence

Date: 2026-07-14. Scope: C3, H1, H8, M1, M2, M5, M8, L1, L2. No deployment,
live Slack call, or external Worker/Container mutation was performed.

## Finding dispositions

- **C3 resolved:** `CloudflareSlackAdapter.fenced()` now appends the exact
  SessionEventDO `done` event while the final render token is held and before
  the final Slack request. Only the exact `execution_already_terminal:<id>`
  result is accepted as prior confirmation; other persistence failures prevent
  the Slack boundary from being crossed. `turn-lifecycle.ts` uses the same
  strict already-terminal handling. Regression coverage proves ordering and
  proves zero Slack requests when terminal persistence fails.
- **H1 resolved:** each AG-UI run carries the durable execution ID in AG-UI
  context and `x-opentag-execution-id`. The named runtime process tracks that
  exact SSE request and agent abort controller and exposes
  `/opentag/control/interrupt`; it aborts the exact controller and returns
  matching `{accepted:true,quiescent:true}` only after the agent stream's
  `finally` settles. Stop requires that exact proof through `AGENT_RUNTIME`
  before `markCancelControlled` or `Stopped`; isolate-local abort is only a
  latency optimization. Tests reject mismatched/non-quiescent responses.
- **H8 resolved:** quick interaction parsing, stable identity derivation, and
  transactional `preAdmitSlackTurn` now run synchronously before HTTP 200.
  Only the already-owned profile/framework handoff is placed in `waitUntil`.
  Persistence failure returns 503; stable duplicates return a deliberate 200.
- **M1 resolved by explicit renderer choice:** production AG-UI continues to
  use the Channels incremental renderer as the supported conflation equivalent
  (single accumulated throttled message, tool-call-ID coalescing). Useful tool
  lifecycle progress is enabled. Docs now distinguish it from the adapter
  `stream()` bespoke conflation helper and do not claim unimplemented harness
  task/plan events.
- **M2 resolved for request-time paths:** initial `Thinking` status is
  best-effort and cannot abort model execution; Channels supplies coalesced
  tool activity; final cleanup remains best-effort; request-time Stop clears
  status before acknowledgement. The store owner must retain the same
  idempotent clear in alarm-resumed Stop continuation (integration note below).
- **M5 resolved:** configured artifact-domain URLs in a final AG-UI answer are
  decorated in the same final fenced Slack update with Re-generate, View files,
  and Delete synthetic-turn cards. Per-thread/artifact markers prevent repeated
  cards, buttons keep stable click identity, and answer blocks are never evicted
  to make room. Configure `QUICK_BASE_DOMAIN`.
- **M8 resolved with store integration:** lifecycle persists the exact immutable
  SessionEvent admission handoff before its cross-DO call. The owning DO alarm
  retries only that pre-runtime admission with bounded attempts; lifecycle
  waits for exact accepted/cancelled/duplicate/exhausted state and never retries
  model/tool execution. Accepted fast-path cleanup failure is benign because an
  alarm can observe only exact duplicate.
- **L1 resolved:** `session-link.ts` issues seven-day HMAC-SHA256 tokens. The
  read-only `/sessions/:token` view returns SessionEventDO state/events with
  private no-store/noindex headers. A once-per-thread final-message context
  block links the viewer and names the effective runtime. Configure
  `SESSION_VIEWER_BASE_URL` with `ADMIN_SECRET`.
- **L2 resolved in owned docs:** `docs/centaur-port.md` now says core-spine
  landed and explicitly lists remaining subfeatures; operations/configuration
  and renderer/viewer behavior are accurate; the A2 implementation note is
  labeled historical. The stale SessionEventDO authority comment is in the
  forbidden `edge/src/store/**` surface and was assigned to the store owner.

## Focused verification

- `npm run check-types` at repository root: PASS.
- `npx vitest run test/control-surfaces.test.ts test/quick-actions.test.ts
  test/stop-command-routing.test.ts`: PASS, 45 tests.
- Focused `test/slack-stream.test.ts` terminal-order/failure-closed cases:
  PASS, 4 tests.
- Combined targeted selector after final integration: PASS, 28 selected tests
  across four files.
- `edge/npm run typecheck`: adapter/control production source is clean. At the
  final evidence snapshot one parallel store-test mismatch remains:
  `test/render-obligation.test.ts:76` passes `liveMessageState` to
  `obligation.set`, whose current contract does not accept that field. This is
  not suppressed or presented as passing.

## Cross-owner integration requirements

1. Store owner: reconcile the remaining `render-obligation.test.ts` fixture
   with the obligation-set contract so the full edge typecheck becomes green.
2. Store owner: preserve idempotent Slack status clear in alarm-resumed Stop
   continuation before its visible acknowledgement (M2).
3. Store owner: correct the prohibited-to-this-task top SessionEventDO comment
   so SQL `executions/events/cancelled_executions` are authoritative and old KV
   slots are not described as terminal/execution truth (L2).
4. Runtime/operator: `AGENT_RUNTIME`, `AGENT_URL`, `ADMIN_SECRET`, and optional
   viewer/card vars must be configured before those surfaces are live. This
   remediation deliberately did not deploy or mutate those bindings.

## Primary changed files

`runtime.ts`; `lib/triage-agent.ts`;
`edge/src/{agent-turn.ts,bot-engine.ts,env.ts,worker.ts}`;
`edge/src/slack/{cloudflare-slack-adapter.ts,quick-actions.ts,session-link.ts,
stop-routing.ts,turn-lifecycle.ts}`; `edge/test/{control-surfaces.test.ts,
quick-actions.test.ts,slack-stream.test.ts}`; `docs/{centaur-port.md,
operations.md}`; `implementation-notes.md`.
