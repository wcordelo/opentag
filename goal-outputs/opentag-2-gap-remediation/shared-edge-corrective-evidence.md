# Shared-edge corrective evidence

Date: 2026-07-16 (America/Los_Angeles)

Scope: corrective attempt 3 for C2, H3, H4, H8, M3, and L2. No Worker or
Container deployment, Slack app reinstall, live Slack/API message, GitHub
write, commit, push, PR mutation, or other external mutation was performed.

## Source-level corrections

- **C2 — page identity and bodies now reconcile across live and recovery.**
  `edge/src/slack/client-message-id.ts` owns one canonical continuation-page
  helper derived only from the execution ID and canonical page index.
  `edge/src/slack/cloudflare-slack-adapter.ts` uses it for both stream and
  AG-UI continuations. `edge/src/store/conversation-state-do.ts` uses the same
  helper for successful alarm replay, emits the raw canonical output without a
  recovery prefix, and reserves a separate namespace for recovery diagnostics.
  Ambiguous continuation transport releases the render token because replaying
  the identical stable ID/body is safe.

- **H3/H8 — a 200 response implies a repairable nonterminal job and alarm.**
  `edge/src/deferred-ingress-do.ts` re-checks pending/running duplicates and
  re-arms a missing alarm at the preserved retry deadline; completed and
  exhausted jobs remain terminal. `edge/src/worker.ts` persists immutable
  `late_file`, `quick_action`, and ordinary `file_turn` callbacks before
  acknowledging Slack. File-turn alarms re-enter exact pre-admission and only
  complete after framework handoff.

- **H4 — bot and research reserve the same per-channel durable owner.**
  `edge/src/slack/web-api.ts` reserves inside every HTTP attempt, including
  Retry-After replays. `lib/research/delivery/slack.ts` accepts the same
  scheduler discipline, retries identical form/client IDs after 429, and
  returns `ambiguous` after retry exhaustion. The Orchestrator therefore keeps
  the delivery drainable instead of suppressing it.
  `edge/wrangler.research.toml` binds `SLACK_RATE_LIMIT` to the bot-owned
  `SlackRateLimitDO` using `script_name = "opentag-bot"`.

- **M3 — bytes and rich runtime output fail closed until canonical.**
  `edge/src/slack/download-files.ts` throws when a configured durable stager
  cannot copy inline bytes; a deferred file callback can retry the same R2
  write after isolate loss. Session input already records the resulting stage
  metadata, and the existing replay/harness path restores staged attachments.
  `edge/src/slack/cloudflare-slack-adapter.ts` now advances its mirror cursor
  only after an awaited append, mirrors tool results before result rendering,
  and propagates output/tool append failures.
  `edge/src/slack/turn-lifecycle.ts` recognizes those failures and performs no
  terminal append, final Slack commit, or obligation clear.

- **L2 — selected Claude behavior is documented truthfully.**
  `ARCHITECTURE.md` no longer claims ordinary non-coding Claude selections may
  fall back to AG-UI. Explicit, sticky, or channel-selected Claude is
  authoritative and fails visibly when disconnected. The existing
  `agent-turn-harness` regressions cover both coding and non-coding turns and
  assert that neither the harness nor `runAgent` is called when unavailable.

## Fault-window regressions

The focused attempt-3 suite:

```text
cd edge
npx vitest run \
  test/deferred-ingress-do.test.ts \
  test/download-files.test.ts \
  test/slack-web-api.test.ts \
  test/research-final-delivery.test.ts \
  test/render-obligation.test.ts \
  test/slack-stream.test.ts \
  test/agent-turn-harness.test.ts
```

Result: **PASS — 7 files, 127/127 tests.**

The regressions prove:

1. an applied-but-response-lost continuation is replayed by the alarm with the
   same canonical ID, fallback text, and blocks; successful recovery has no
   recovery-only prefix;
2. `late_file`, `quick_action`, and `file_turn` rows survive a successful put
   plus failed first `setAlarm`; the identical retry repairs scheduling and
   the internal handoff executes once;
3. a configured inline R2 staging failure aborts the turn, while the next
   durable attempt stages the exact original bytes and records the stage key;
4. research 429 honors Retry-After, reserves every attempt, resends the
   identical form/client ID, and remains ambiguous/drainable after exhaustion;
5. bot and research writes against one channel call the same cross-script
   reservation owner sequentially;
6. output append failure causes no Slack update, `done`, or final-row clear;
   tool-result append happens before the result renderer and its failure causes
   no additional Slack mutation;
7. SessionEvent-only attachment/tool replay reaches the selected harness
   request, and the real harness frontend resolves staged bytes.

Adjacent regression suite:

```text
cd edge
npx vitest run \
  test/quick-actions.test.ts \
  test/late-file-repair.test.ts \
  test/slack-agent-stop.integration.test.ts \
  test/harness-container-router.test.ts \
  test/session-history.test.ts
```

Result: **PASS — 5 files, 65/65 tests.**

Additional checks:

- `cd edge && npm run typecheck` — **PASS**.
- `cd edge/workers/sandbox && npm run typecheck` — **PASS**.
- `git diff --check` — **PASS**.
- `cd edge && npx wrangler deploy --dry-run --config wrangler.research.toml
  --outdir /tmp/opentag-research-dry-run` — **PASS**. Wrangler reported
  `env.SLACK_RATE_LIMIT (SlackRateLimitDO, defined in opentag-bot)`.

## Files changed by corrective attempt 3

Source/config/docs:

- `ARCHITECTURE.md`
- `edge/src/deferred-ingress-do.ts`
- `edge/src/slack/client-message-id.ts`
- `edge/src/slack/cloudflare-slack-adapter.ts`
- `edge/src/slack/download-files.ts`
- `edge/src/slack/turn-lifecycle.ts`
- `edge/src/slack/web-api.ts`
- `edge/src/store/conversation-state-do.ts`
- `edge/src/worker.ts`
- `edge/workers/orchestrator/src/env.ts`
- `edge/workers/orchestrator/src/OrchestratorDO.ts`
- `edge/wrangler.research.toml`
- `lib/research/delivery/slack.ts`

Tests:

- `edge/test/deferred-ingress-do.test.ts`
- `edge/test/download-files.test.ts`
- `edge/test/render-obligation.test.ts`
- `edge/test/research-final-delivery.test.ts`
- `edge/test/slack-stream.test.ts`
- `edge/test/slack-web-api.test.ts`

## Activation caveats

The manifests describe `DEFERRED_INGRESS`, `BOT_SELF`, `BLOBS`, and the
cross-script `SLACK_RATE_LIMIT` owner, but no deployed Worker was changed in
this run. The new durability behavior becomes active only after an operator
explicitly deploys matching bot and research configurations and secrets.

---

# Corrective attempt 4 — C2, H3, M3, L2

Date: 2026-07-16

## Implemented invariants

- **C2 — canonical AG-UI pages are independent of decorations.**
  `edge/src/slack/cloudflare-slack-adapter.ts` now renders every final answer
  page from `buildSlackMessagePages(args.text)` and sends the exact canonical
  text, blocks, thread, page boundary, and
  `stableSlackPageClientMessageId(executionId, pageIndex)` used by alarm
  recovery. Session-view context and Quick artifact cards are sent as a
  separate, stable-ID Slack effect and never mutate page 0 or a continuation.
  The decorated applied-response-loss regression captures the normal AG-UI
  continuation request and compares it directly with both alarm attempts.

- **H3 — staging and delayed-file correlation fail closed.**
  A configured attachment stager now throws
  `attachment_staging_failed:<name>:<cause>` at every size tier. The regression
  uses a 6-byte PDF with `maxInlineBytes: 4`: the first R2 put fails, the
  durable retry receives the same six bytes, and the successful result is a
  staged attachment.
  Delayed-file pending mentions are append-only rows scoped by
  team/channel/user and uniquely identified by Slack `eventId`; one mention can
  no longer overwrite another. Exact `thread_ts` selects one pending mention.
  An unthreaded or multiply exact match fails closed as ambiguous. Successful
  and already-deduped synthetic handoffs write a consumed marker. The Worker
  regression stores two same-user/channel mentions, delivers their uploads in
  reverse order, and proves each deferred job retains the intended original
  event.

- **M3 — canonical replay rejection stops the production lifecycle.**
  `edge/src/agent-turn.ts` and the initial obligation cursor read wrap replay
  rejection as `session_event_replay_failed:<cause>`.
  `edge/src/slack/turn-lifecycle.ts` treats that prefix like an output/tool
  append failure: neither harness nor AG-UI starts, no done or final Slack
  message is written, and no obligation is cleared. The production
  `/agent` ingress regression keeps the exact zero-attempt obligation while
  asserting both runtime bindings and final `chat.postMessage` remain unused.

- **L2 — strict documentation semantics.**
  `ARCHITECTURE.md` and `docs/operations.md` now say SessionEvent input/output
  and tool data are canonical before Slack delivery. Append or replay failure
  suppresses runtime/final delivery and leaves the exact lifecycle retryable.
  A search across `ARCHITECTURE.md`, `PRODUCT.md`, `DECISIONS.md`, and
  `docs/*.md` found no remaining best-effort SessionEvent mirroring claim.

## Focused verification

```text
cd edge
npm test -- --run \
  test/download-files.test.ts \
  test/late-file-repair.test.ts \
  test/worker-deferred-ingress.test.ts \
  test/slack-stream.test.ts \
  test/render-obligation.test.ts \
  test/agent-turn-harness.test.ts \
  test/slack-agent-stop.integration.test.ts
```

Result: **PASS — 7 files, 115/115 tests.**

Additional checks:

- `cd edge && npm run typecheck` — **PASS**.
- `cd edge/workers/sandbox && npm run typecheck` — **PASS**.
- `git diff --check` — **PASS**.

## Attempt-4 files

Source and canonical docs:

- `ARCHITECTURE.md`
- `docs/operations.md`
- `edge/src/agent-turn.ts`
- `edge/src/slack/cloudflare-slack-adapter.ts`
- `edge/src/slack/download-files.ts`
- `edge/src/slack/late-file-repair.ts`
- `edge/src/slack/turn-lifecycle.ts`
- `edge/src/worker.ts`

Regressions:

- `edge/test/agent-turn-harness.test.ts`
- `edge/test/download-files.test.ts`
- `edge/test/late-file-repair.test.ts`
- `edge/test/render-obligation.test.ts`
- `edge/test/slack-agent-stop.integration.test.ts`
- `edge/test/worker-deferred-ingress.test.ts`

## Remaining risk

No scoped C2/H3/M3/L2 blocker is known after the focused checks. The parent
goal still owns the full repository validation and a fresh independent
adversarial review. No Worker, Container, secret, Slack configuration, or other
external state was deployed or changed by this attempt.

---

# Corrective attempt 5 — C4/H7 exact-byte paging and H3 admission concurrency

Date: 2026-07-16

## Implemented invariants

- **C4/H7 — Slack segmentation and paging are byte-for-byte lossless.**
  `splitIntoSegments` retains the selected boundary newline inside its segment
  and never deletes a leading newline from the remainder. Concatenating all
  returned segments therefore equals the input for newlines at position zero,
  exactly at or near 3,000 characters, repeated newlines, and multi-page
  boundaries. Every segment remains at most 3,000 characters.
  `buildSlackMessagePages` derives each fallback from the exact concatenation
  of that page's blocks, without inserting delimiters; only the documented
  35,000-character fallback truncation can shorten it.

- **C4/H7 — normal and alarm-recovery render the same canonical bytes.**
  The adapter retains exact AG-UI text deltas for the terminal page build, and
  `reconstructMarkdown` no longer trims persisted output during recovery.
  The applied-response-lost regression uses newline-rich content crossing both
  the 3,000-character block boundary and 50-block page boundary, then compares
  the complete normal and recovery continuation request bodies, including
  text, serialized blocks, thread, and stable client message ID.

- **H3 — pre-admission preserves exact duplicate versus concurrency.**
  `preAdmitSlackTurnResult` exposes `accepted`, `duplicate`, `concurrent`, and
  `ineligible` outcomes while the existing wrapper remains compatible for
  unaffected callers. Ordinary deferred file turns acknowledge an exact
  duplicate idempotently, but a distinct active execution throws a retryable
  error so `DeferredIngressDO` retains the job and schedules backoff.

- **H3 — late-file idle races cannot consume the pending mention.**
  A late-file repair that observes idle and then loses registration to a new,
  distinct active execution returns retryable failure without writing the
  consumed marker. After the active turn clears, the alarm retry registers,
  hands off exactly once, completes, and only then marks the original pending
  mention consumed. An exact duplicate still marks consumed because the same
  synthetic execution was already admitted.

## Production-boundary regressions

- New `deferred-admission-concurrency.test.ts` exercises the real Worker
  internal deferred-ingress route behind a real `DeferredIngressDO` alarm and
  the production SQLite-backed `ActiveTurnEngine` registration state machine:
  - distinct concurrent ordinary `file_turn` stays pending/rearmed, then
    succeeds with one handoff;
  - exact duplicate completes without a second handoff;
  - late-file idle-check race stays pending and unconsumed, then retries once
    and consumes after successful handoff.
- `stream-render-pages.test.ts` covers newline position zero, exact/near-3,000
  boundaries, repeated newlines, the 50-block boundary, exact reconstruction,
  fallback equality when the page is at most 35,000 characters, and all Slack
  limits.
- `render-obligation.test.ts` covers exact persisted whitespace and
  byte-identical normal/recovery continuation output across both paging
  boundaries. The existing 200,000-character behavior remains covered.

## Verification

Focused corrective suite:

```text
cd edge
npm test -- --run \
  test/stream-render-pages.test.ts \
  test/pre-admit-turn.test.ts \
  test/deferred-admission-concurrency.test.ts \
  test/render-obligation.test.ts \
  test/deferred-ingress-do.test.ts \
  test/worker-deferred-ingress.test.ts \
  test/late-file-repair.test.ts \
  test/cloudflare-slack-adapter.test.ts
```

Result: **PASS — 8 files, 74/74 tests.**

Full current edge suites:

- `cd edge && npm test` — **PASS: 54 files, 679/679 tests**.
- `cd edge && npm run test:e2e` — **PASS: 1 file, 25/25 tests**.
- `cd edge && npm run typecheck` — **PASS**.
- `cd edge/workers/sandbox && npm run typecheck` — **PASS**.
- `git diff --check` — **PASS**.

## Attempt-5 files

Source:

- `edge/src/slack/stream-render.ts`
- `edge/src/slack/pre-admit-turn.ts`
- `edge/src/worker.ts`
- `edge/src/slack/cloudflare-slack-adapter.ts`
- `edge/src/store/conversation-state-do.ts`

Regressions:

- `edge/test/stream-render-pages.test.ts`
- `edge/test/pre-admit-turn.test.ts`
- `edge/test/deferred-admission-concurrency.test.ts`
- `edge/test/render-obligation.test.ts`

Evidence artifact size after this update: **15,300 bytes**.

## Remaining risk

No scoped C4/H7 or H3 blocker is known after the focused and full checks.
The parent goal still owns validator hardening, report reconciliation, and a
fresh independent adversarial review. No Worker, Container, secret, Slack
configuration, or other external state was deployed or changed.
