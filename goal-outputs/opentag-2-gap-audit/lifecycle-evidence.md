# OpenTag 2.0 lifecycle and durability gap audit

Audit date: 2026-07-13
Scope: production Slack ingress, live rendering/conflation, progress status, Stop/interrupt, ConversationStateDO obligations/alarms, SessionEventDO persistence/replay, deduplication, Slack block limits, and rate-limit behavior.
Method: traced `edge/src/worker.ts` through the adapter and lifecycle into both Durable Objects and Slack egress; reviewed relevant unit/integration tests; ran the current suites. No deployment or product-source mutation was performed.

## Executive verdict

The production ingress, stable identities, pre-admission, exact render/effect fences, durable Stop state machine, SessionEventDO registration, replay filtering, and 50-block clamps are real and live. The merged implementation is nevertheless **not yet safe to describe as satisfying the correctness-critical durability contract**. Two critical boundaries remain open:

1. a live Slack write and its durable final confirmation cannot be reconciled idempotently because the obligation does not retain the live Slack message reference; recovery can post a second answer, contrary to the no-duplicates rule; and
2. the normal AG-UI path commits final Slack visibility before it attempts (and may silently fail) the terminal SessionEventDO write, which can leave the per-thread session permanently “executing” after the user has already seen success.

There are also high-severity gaps in cross-isolate AG-UI interruption, Slack 429 handling, finite obligation abandonment, fallback size bounds, and crash-atomic SessionEventDO transitions. The historical “A1/A2 done” notes are therefore useful implementation history, not a current correctness proof.

## Contract used for judgment

- `SPEC.md:114-139` requires obligations to retain `{executionId, afterEventId, messageRef}`, replay on alarm, and resolve to a named visible/size outcome.
- `SPEC.md:145-170` requires idempotent execute, cursor replay, exact interrupt, and append-only session events.
- `SPEC.md:187-229` requires incremental update-in-place rendering, conflation, 50-block/3,000-character/35k limits, and approximately one `chat.update` per second per channel.
- `SPEC.md:414-426` names the original gaps: streaming, delivery guarantee, progress, interrupt, isolate-local state, observability, and the console/viewer.
- `ARCHITECTURE.md:138-177` says output/terminal events precede render confirmation and that runtime state is never the only delivery truth.
- `ARCHITECTURE.md:216-253` promises exact-execution replay, live deferral, stale-execution recovery, and terminal state even when incremental output mirroring is best effort.
- `ARCHITECTURE.md:448-459` locks durable pre-admission, exact render/effect fencing, joint event-log plus visible-surface confirmation, and Stop success only after runtime control.
- `DECISIONS.md:149-193` locks stable IDs/pre-admission, exact render/effect/rejection fences, cursor refresh, and Stop as a durable exact-runtime continuation.
- `GOAL.md:14-24` says never duplicate, enforce 50 blocks, cap `chat.update` at about one per second **per channel**, do not bypass conflation, and require tests/typecheck.

## Ranked findings

### Critical

#### C1. Render obligations cannot reconcile an ambiguously successful live Slack write; alarm recovery can duplicate an answer

**Verdict:** Deficient and production-live.

**Evidence:**

- The specified obligation includes `messageRef` (`SPEC.md:114-129`), but the actual row stores only thread key, execution ID, event cursor, channel, thread timestamp, deadline, and attempt (`edge/src/store/schema.ts:70-85`; `edge/src/store/conversation-state-do.ts:147-178`). There is no live message timestamp or deterministic live-post identity.
- The live renderer performs `chat.update` first and only then confirms the render token (`edge/src/slack/cloudflare-slack-adapter.ts:920-936`; `edge/src/slack/active-turn-registry.ts:144-170`). Final confirmation atomically deletes the active row and obligation (`edge/src/store/active-turn-engine.ts:515-548`). A Worker/DO failure after Slack applied the write but before confirmation leaves an ambiguous token/obligation.
- Recovery cannot update or inspect that existing message. It always constructs a new `chat.postMessage` and uses a recovery-only `client_msg_id` derived from the obligation (`edge/src/store/conversation-state-do.ts:1146-1162`). Live placeholder/final posts do not use that recovery ID (`edge/src/slack/cloudflare-slack-adapter.ts:820-837`, `945-968`).
- After the active row expires, recovery explicitly proceeds without a token (`edge/src/store/conversation-state-do.ts:1134-1144`). Therefore a live update that Slack applied but whose confirmation was lost can later be followed by a second recovered answer.

**Why Critical:** This breaks both the central no-duplicate house rule (`GOAL.md:18`) and the advertised “confirmed live execution is deferred rather than double-posted” contract (`ARCHITECTURE.md:223-236`) on exactly the crash/ambiguity path obligations exist to handle.

**One-line fix:** Persist the live message `ts` and a deterministic per-execution Slack idempotency key in the obligation as soon as the placeholder/post is created, and make recovery update/reconcile that same message (or repeat the same `client_msg_id`) before it is ever allowed to create a new fallback.

#### C2. Normal AG-UI success is visibly committed before terminal SessionEventDO persistence, and terminal persistence failure is swallowed

**Verdict:** Deficient and production-live for ordinary agent turns.

**Evidence:**

- `runBundledAgentTurn()` returns completed after `thread.runAgent()` (`edge/src/agent-turn.ts:940-949`). The AG-UI renderer's final Slack request is marked final and therefore deletes the active row plus obligation when confirmed (`edge/src/slack/cloudflare-slack-adapter.ts:998-1043`; `edge/src/store/active-turn-engine.ts:515-548`).
- Only after that completed result returns does the lifecycle call `terminalizeSessionExecution()` (`edge/src/slack/turn-lifecycle.ts:445-449`).
- `terminalizeSessionExecution()` catches and discards every append failure (`edge/src/slack/turn-lifecycle.ts:129-143`).
- SessionEventDO admits one active execution per thread and rejects a different execution while a nonterminal row remains (`edge/src/store/session-event-do.ts:208-218`, `277-286`). Thus a transient failure appending `done` after visible success can leave the thread durably wedged as “executing” and reject all later asks.
- Incremental output mirroring is also explicitly best effort and swallowed (`edge/src/slack/cloudflare-slack-adapter.ts:226-252`), so the event log is not a required source of truth on this path despite invariant 5 (`ARCHITECTURE.md:456-457`).

**Why Critical:** A single post-success persistence failure can both falsify the claimed source of truth and permanently deny future turns in the thread, while the user has already been shown success and the recovery obligation has been deleted.

**One-line fix:** Make AG-UI terminal event persistence a required precondition of the final Slack commit (or retain a durable terminalization obligation/active row until it succeeds); never swallow a failed `done` append after final visibility.

### High

#### H1. Stop can acknowledge cross-isolate AG-UI work as controlled without actually interrupting the running request

**Verdict:** Partial. Exact suppression is durable; exact AG-UI runtime interruption is not.

**Evidence:**

- Stop correctly short-circuits before normal routing (`edge/src/worker.ts:160-176`) and installs an exact durable cancellation/tombstone before runtime control (`edge/src/slack/stop-routing.ts:199-240`, `296-305`).
- Harness execution receives an authenticated exact `/interrupt` and must accept it (`edge/src/slack/stop-routing.ts:307-324`), but AG-UI control is only `getOrCreateBot(env).adapter.abortConversation(conversationKey)` (`edge/src/slack/stop-routing.ts:327-334`).
- `abortConversation()` only looks in the current isolate's in-memory `agentsByConversation` map, returns no success/quiescence result, and swallows abort errors (`edge/src/slack/cloudflare-slack-adapter.ts:173-195`, `334-347`). If Stop is handled by another isolate, it aborts nothing.
- The handler nevertheless marks the exact turn controlled and proceeds to “Stopped” (`edge/src/slack/stop-routing.ts:335-368`). Alarm continuation similarly interrupts SessionEventDO/harness but has no AG-UI abort step (`edge/src/store/conversation-state-do.ts:839-872`).
- Render and tool-effect fences do prevent late user-visible output or new side effects (`edge/src/slack/cloudflare-slack-adapter.ts:271-299`; `edge/src/tools/index.ts:62-83`, `92-145`), so this is not an answer-after-Stop hole; it is a false runtime-control/quiescence claim and wasted live compute.

**Why High:** It violates locked Stop ordering (`DECISIONS.md:181-193`) and architecture invariant 6 (`ARCHITECTURE.md:458-459`). The visible result is suppressed safely, but “Stopped” does not prove the AG-UI runtime stopped.

**One-line fix:** Give AG-UI runs a durable exact-execution control endpoint/service binding (or a DO-mediated abort channel) that returns definitive acceptance/quiescence, and gate `markCancelControlled` on that result.

#### H2. Slack rate limiting is a throttle hint, not a per-channel limiter, and 429/`Retry-After` is ignored

**Verdict:** Deficient.

**Evidence:**

- The raw Slack client performs one `fetch`, parses JSON, and throws on any `ok:false`; it never checks HTTP 429 or `Retry-After` (`edge/src/slack/web-api.ts:150-188`, `198-223`). `ratelimited` becomes a generic definitive `SlackApiError` (`edge/src/slack/web-api.ts:72-84`).
- `adapter.stream()` uses an 800ms interval local to one stream (`edge/src/slack/cloudflare-slack-adapter.ts:838-884`). The live AG-UI path creates independent message streams through `createRunRenderer()` (`edge/src/slack/cloudflare-slack-adapter.ts:902-991`), so concurrent threads in the same channel have no shared channel budget.
- The test suite explicitly treats `{ok:false,error:"ratelimited"}` as a definitive render rejection, not a retry (`edge/test/slack-stream.test.ts:298-340`).
- This contradicts the per-channel rule (`GOAL.md:20`) and the SPEC's rate-limit requirement (`SPEC.md:224-229`).

**Why High:** A routine Slack backpressure response can fail a final render, reopen its fence, and route the turn into slow alarm recovery instead of honoring Slack's retry window; concurrent threads can amplify the problem.

**One-line fix:** Centralize Slack egress behind a per-channel scheduler (>=1s completion-to-next-start), honor HTTP 429 and `Retry-After` with bounded idempotent retries, and preserve final-render ownership while retrying.

#### H3. After three definitive fallback failures, the alarm drops the obligation with no visible or durable terminal outcome

**Verdict:** Deficient.

**Evidence:**

- Due obligations are deleted before delivery (`edge/src/store/conversation-state-do.ts:967-976`).
- Non-deferred failures are reinserted only while `attempt + 1 < 3`; after the third failure no row is restored (`edge/src/store/conversation-state-do.ts:991-1003`).
- No `failed_size_limit` or durable dead-letter outcome is emitted; only `fallback_sent` and `error_visible` are implemented (`edge/src/store/conversation-state-do.ts:1091-1110`, `1208-1214`). A source search finds no implementation of `streamed`, `answer_visible`, or `failed_size_limit` outside comments.
- The SPEC requires every turn to reach the named outcome taxonomy (`SPEC.md:134-139`).

**Why High:** Repeated Slack rejection converts the “never silent” guarantee into permanent silence and loses the only recovery row.

**One-line fix:** Never discard the last obligation silently: retain a durable dead-letter/outcome row, classify size failures explicitly, honor rate-limit retry timing, and keep retry/alert ownership until visibility or an operator-resolvable terminal outcome is recorded.

#### H4. Recovery posts unbounded replay text, so large recoveries can repeatedly fail and then hit H3

**Verdict:** Deficient.

**Evidence:**

- `reconstructMarkdown()` concatenates every matching output event without a bound (`edge/src/store/conversation-state-do.ts:388-407`).
- `postFallback()` puts that entire string directly into the Slack `text` form field with no 35k clamp, blocks, or overflow message (`edge/src/store/conversation-state-do.ts:1091-1109`, `1146-1162`).
- The dedicated 35k/3,000/50 limit helpers are used only by `adapter.stream()` (`edge/src/slack/stream-render.ts:13-75`; `edge/src/slack/cloudflare-slack-adapter.ts:852-860`), not recovery.

**Why High:** Long outputs are most likely to need robust recovery, yet the recovery path violates the same Slack size contract and can be discarded after three failures.

**One-line fix:** Run reconstructed output through the shared Slack budgeter, split overflow deterministically across idempotent message IDs (or update the known live message), and record `failed_size_limit` if content cannot be represented.

#### H5. SessionEventDO's multi-row state transitions are not crash-atomic

**Verdict:** Deficient durability despite correct single-isolate serialization.

**Evidence:**

- `execute()` checks cancellation/dedup, inserts an `executions` row, then inserts one or more input events as separate SQL statements without `transactionSync` (`edge/src/store/session-event-do.ts:186-274`). A crash after the execution row but before input rows can leave a nonterminal active execution that later appears duplicate/concurrent forever.
- `appendEvent(done)` inserts the done event and updates `terminal_at` in separate statements (`edge/src/store/session-event-do.ts:289-333`).
- `interruptExpected()` inserts a tombstone, inserts a done event, and updates `terminal_at` separately (`edge/src/store/session-event-do.ts:368-397`).
- By contrast, `ActiveTurnEngine` explicitly receives a transaction runner and wraps multi-table transitions (`edge/src/store/active-turn-engine.ts:48-70`, `515-548`). SessionEventEngine has no transaction dependency (`edge/src/store/session-event-do.ts:112-139`).

**Why High:** DO request serialization prevents concurrent interleaving but does not make several SQLite commits crash-atomic; the precise crash windows can wedge admission or create inconsistent terminal history.

**One-line fix:** Add a transaction runner to SessionEventEngine and wrap execute admission/input inserts, done append/terminal update, and interrupt tombstone/done/terminal update in one SQLite transaction each.

### Medium

#### M1. `conflateChatSdkStream` is correct but not on the live @mention render path; structured progress remains an unwired Centaur hook

**Verdict:** Partial, explicitly acknowledged but overstated in current port documentation.

**Evidence:**

- The conflation implementation correctly eagerly drains and merges markdown/task/plan chunks (`edge/src/slack/conflate.ts:29-109`).
- It is used by `CloudflareSlackAdapter.stream()` (`edge/src/slack/cloudflare-slack-adapter.ts:813-891`).
- The live agent path instead constructs the framework `createRunRenderer()` (`edge/src/slack/cloudflare-slack-adapter.ts:902-991`) and never calls `conflateChatSdkStream`.
- `implementation-notes.md:342-349` explicitly says `adapter.stream()` is not the live @mention path and structured task/plan cards are only a future hook. `docs/centaur-port.md:278-282` likewise says harness output is accumulated into one final post and richer task/plan chunks are future work.

**Why Medium:** Text streaming is live through the Channels renderer, so the user-visible no-streaming gap is fixed. But GOAL's “do not bypass” rule is not literally met, and Centaur's structured task/plan conflation and live coding progress are not delivered.

**One-line fix:** Route the production AG-UI/harness chunk stream through one shared conflation-aware renderer, including `task_update`/`plan_update`, or amend the locked house rule/docs to make the Channels stream the deliberate equivalent and test its guarantees directly.

#### M2. Progress status uses the correct root `thread_ts`, but it is static “Thinking…” rather than activity/task progress

**Verdict:** Thread identity confirmed; progress depth partial.

**Evidence:**

- Event normalization derives top-level mention/thread scope correctly (`edge/src/slack/cloudflare-slack-adapter.ts:380-408`) and binds root `threadTs` into immutable request context (`edge/src/slack/cloudflare-slack-adapter.ts:449-472`).
- The lifecycle validates timestamp shape and selects scope/root before calling status (`edge/src/slack/turn-lifecycle.ts:200-216`, `385-391`); `firstSlackTs()` only accepts Slack timestamp-shaped strings (`edge/src/slack/obligation-thread-key.ts:9-14`).
- Status clearing uses the same exact root and fence (`edge/src/slack/turn-lifecycle.ts:477-489`).
- However, the only explicit lifecycle status is “Thinking…”, and the live renderer disables tool-status rows (`edge/src/slack/cloudflare-slack-adapter.ts:980-991`). No application source maps activity summaries or task updates to status, despite `SPEC.md:268-279` describing that progress path.

**Why Medium:** The original wrong-`thread_ts` class is fixed and fenced, but multi-minute work exposes only generic thinking, not the richer Centaur progress visibility promised by the gap table.

**One-line fix:** Map durable activity/task summaries to bounded status/task cards on the same exact fence and thread root, with rate-limited/coalesced updates.

#### M3. Alarm-resumed Stop does not clear assistant status

**Verdict:** Partial.

**Evidence:**

- Request-time Stop best-effort clears status before posting “Stopped” (`edge/src/slack/stop-routing.ts:348-368`).
- Durable alarm continuation posts the idempotent “Stopped” acknowledgement and clears lifecycle state but never calls `assistant.threads.setStatus` (`edge/src/store/conversation-state-do.ts:908-948`).

**Why Medium:** If the originating Worker dies before status cleanup, the durable continuation can complete visibly while Slack still displays stale “Thinking…” until Slack's own expiry behavior.

**One-line fix:** Add a fenced/idempotent status-clear step to the persisted Stop continuation before its final acknowledgement confirmation.

#### M4. Deduplication is durable and exact, but its event/execution history is unbounded

**Verdict:** Correct for idempotency; deficient for bounded retention.

**Evidence:**

- Stable execution and forwarded-message IDs derive from immutable Slack identity (`edge/src/request-context.ts:76-113`), and pre-admission registers before enrichment (`edge/src/slack/pre-admit-turn.ts:118-157`).
- Session execution deduplicates both `execution_id` and unique `forwarded_message_id` (`edge/src/store/session-event-do.ts:48-63`, `205-249`), and quick actions generate deterministic click identity then re-enter pre-admission (`edge/src/slack/quick-actions.ts:134-142`, `174-256`).
- There is no cap/retention deletion for `events`, `executions`, or `cancelled_executions`; the historical 1,000-ID cap from SPEC §2.6 was explicitly deferred (`implementation-notes.md:294-299`).

**Why Medium:** Correctness improves with durable history, but long-lived DM/thread DOs grow monotonically and cancellation tombstones never age out; this is an operational durability risk rather than a current duplicate hole.

**One-line fix:** Add cursor-safe compaction/retention (preserving active executions and a bounded recent dedup window) plus tests that old rows can be pruned without admitting a recent redelivery.

### Low

#### L1. SessionEventDO comments and historical notes still describe KV slots that are no longer authoritative

**Verdict:** Documentation drift.

**Evidence:**

- Module comments and RPC docs describe `session:executing`/`session:interrupted` KV state (`edge/src/store/session-event-do.ts:13-19`, `486-511`; `implementation-notes.md:251-256`).
- Actual active execution and cancellation truth lives in SQL `executions` and `cancelled_executions`; `KEY_EXECUTING` and `KEY_INTERRUPTED` are only deleted, never written (`edge/src/store/session-event-do.ts:87-92`, `154-164`, `277-286`, `368-425`).

**Why Low:** Runtime behavior is internally consistent and tests use the SQL model, but stale commentary obscures the real source of truth during future maintenance.

**One-line fix:** Rewrite the comments/notes to name SQL as authoritative and remove the unused KV constants/deletes after migration compatibility is confirmed.

## Scope-by-scope verdict matrix

| Audited surface | Verdict | Severity if deficient | Production-path evidence |
| --- | --- | --- | --- |
| Events API ingress | Confirmed live | — | `edge/src/worker.ts:146-209`; production entry `edge/wrangler.bot.toml:4-7` |
| Stop before routing | Confirmed live | — | `edge/src/worker.ts:160-176`; detection boundaries `edge/src/slack/stop-routing.ts:85-121` |
| Durable pre-admission before enrichment | Confirmed live | — | `edge/src/worker.ts:178-195`; atomic active row + obligation `edge/src/slack/pre-admit-turn.ts:118-157`; active transaction `edge/src/store/active-turn-engine.ts:56-116` |
| Stable execution/forwarded IDs | Confirmed live | — | `edge/src/request-context.ts:76-113`; SessionEventDO unique dedup `edge/src/store/session-event-do.ts:48-63`, `205-249` |
| Live incremental text | Confirmed, alternate implementation | — | production `createRunRenderer` path `edge/src/slack/cloudflare-slack-adapter.ts:902-1044`; historical disclosure `implementation-notes.md:342-349` |
| `conflateChatSdkStream` on live renderer | Partial/dead for @mentions | Medium | only `adapter.stream()` uses it: `edge/src/slack/cloudflare-slack-adapter.ts:813-891`; live path starts at `902` |
| Progress status and root `thread_ts` | Root correct; progress partial | Medium | `edge/src/slack/turn-lifecycle.ts:200-216`, `385-391`, `477-489` |
| Exact render/effect fences | Confirmed live | — | `edge/src/slack/cloudflare-slack-adapter.ts:271-299`; `edge/src/tools/index.ts:92-145`; transactional state `edge/src/store/active-turn-engine.ts:482-590` |
| Exact Stop state/ack ordering | Confirmed for durable state, harness, research | — | `edge/src/slack/stop-routing.ts:199-324`, `348-433`; alarm continuation `edge/src/store/conversation-state-do.ts:833-958` |
| AG-UI runtime interrupt | Partial/isolate-local | High | `edge/src/slack/cloudflare-slack-adapter.ts:173-195`, `334-347`; `edge/src/slack/stop-routing.ts:327-340` |
| ConversationStateDO alarm scheduling | Confirmed live | — | construction/scheduling `edge/src/store/conversation-state-do.ts:442-502`; production binding `edge/wrangler.bot.toml:10-34` |
| Obligation exact execution/cursor replay | Confirmed | — | guarded set/clear `edge/src/store/conversation-state-do.ts:204-369`; exact replay filtering `388-407`, `1082-1110` |
| Obligation message reconciliation | Missing | Critical | schema `edge/src/store/schema.ts:70-85`; fallback always new post `edge/src/store/conversation-state-do.ts:1146-1162` |
| Never-silent terminal ownership | Partial | High/Critical | finite deletion `edge/src/store/conversation-state-do.ts:967-1003`; post-success terminal swallow `edge/src/slack/turn-lifecycle.ts:129-143`, `445-449` |
| Session event persistence/replay | Implemented and bound | — | schema/RPC `edge/src/store/session-event-do.ts:39-69`, `289-366`, `440-520`; binding `edge/wrangler.bot.toml:22-34` |
| Session event source-of-truth guarantee | Broken on AG-UI finalization failure | Critical | final Slack precedes swallowed `done`: `edge/src/slack/turn-lifecycle.ts:445-449`; `129-143` |
| Session transition crash atomicity | Missing | High | multi-statement paths `edge/src/store/session-event-do.ts:186-274`, `289-333`, `368-397` |
| 50-block limit | Confirmed | — | stream clamp `edge/src/slack/stream-render.ts:13-68`; component renderer dependency clamps and emits overflow signal `edge/node_modules/@copilotkit/channels-slack/dist/render/block-kit.js:51-67`; quick-card budget `edge/src/slack/quick-card.ts:35-43`, `99-147` |
| Slack rate-limit handling | Deficient | High | no 429/retry logic `edge/src/slack/web-api.ts:150-188`; local 800ms stream throttle `edge/src/slack/cloudflare-slack-adapter.ts:838-884` |

## Important Centaur functionality still omitted or only partial in this scope

1. **Structured task/plan progress conflation is not live.** The union and conflate algorithm exist, but production @mentions use the Channels renderer and the application does not emit/render `task_update` or `plan_update` cards (`implementation-notes.md:342-349`; `docs/centaur-port.md:278-282`).
2. **Coding output is not live-streamed to Slack.** Harness NDJSON is persisted, but the accumulated answer is posted once at the end (`docs/centaur-port.md:278-280`; `edge/src/agent-turn.ts:881-918`).
3. **No read-only session viewer/console exists.** The port ledger explicitly leaves it future work (`docs/centaur-port.md:270`, `283-284`), so event replay is currently an internal recovery primitive rather than an operator-facing debugging surface.
4. **The complete outcome/metrics taxonomy is absent.** Only fallback/error metrics appear in recovery; `streamed`, `answer_visible`, and `failed_size_limit` are not implemented as delivery accounting (`SPEC.md:134-139`; `edge/src/store/conversation-state-do.ts:1091-1110`, `1208-1214`).

## Confirmed-correct paths worth preserving

- Signed Events API ingress returns promptly and runs work in `waitUntil()` (`edge/src/worker.ts:146-209`).
- Stop recognition precedes bot creation/routing and correctly excludes ordinary top-level channel chatter (`edge/src/worker.ts:160-176`; `edge/src/slack/stop-routing.ts:99-121`).
- Stable Slack IDs and pre-admission agree on DM/thread/top-level mention scope, and active turn plus initial obligation are one transaction (`edge/src/slack/pre-admit-turn.ts:40-81`, `118-157`; `edge/src/store/active-turn-engine.ts:56-116`).
- Duplicate SessionEventDO admission is silent; distinct concurrent work receives a separately deduped busy note (`edge/src/slack/turn-lifecycle.ts:61-103`, `340-378`).
- Every production Slack render/status/title crosses the exact active-turn fence, and tool mutations cross an effect fence (`edge/src/slack/cloudflare-slack-adapter.ts:271-299`; `edge/src/tools/index.ts:62-145`).
- Session replay is cursor-ordered and recovery filters by exact execution ID (`edge/src/store/session-event-do.ts:336-366`; `edge/src/store/conversation-state-do.ts:388-407`).
- Harness NDJSON output is appended before exposure/accumulation and a successful harness result requires durable `done` (`edge/src/harness/client.ts:413-450`, `555-576`).
- User interruption tombstones exact execution IDs and prevents late event appends (`edge/src/store/session-event-do.ts:368-397`; covered by `edge/test/session-event-do.test.ts:144-178`).
- Generic Block Kit output is clamped to 50 with an explicit overflow context block, and the bespoke stream builder also clamps to 50 (`edge/node_modules/@copilotkit/channels-slack/dist/render/block-kit.js:51-67`; `edge/src/slack/stream-render.ts:50-68`).

## Current verification results

All commands were run from `/Users/will/Documents/opentag/edge` on 2026-07-13:

| Command | Result |
| --- | --- |
| `npm test` | PASS — 39 files, 559 tests |
| `npm run test:e2e` | PASS — 1 workerd file, 24 tests |
| `npm run typecheck` | PASS — `tsc --noEmit` |

Coverage is broad at the engine/state-machine level: render-obligation tests cover fallback, live deferral, stale execution, ambiguity, and Stop continuation (`edge/test/render-obligation.test.ts:323-877`); SessionEventDO tests cover execute/replay/interrupt/dedup (`edge/test/session-event-do.test.ts:121-486`); Stop tests cover routing and control races (`edge/test/stop-command-routing.test.ts:58-1066`); stream tests cover fences and 50-block truncation (`edge/test/slack-stream.test.ts:51-622`). However, the only real Worker-ingress integration test is a trivial `/agent` shortcut (`edge/test/slack-agent-stop.integration.test.ts:491-550`), and none of the passing tests injects the critical failure boundaries in C1/C2/H5 (Slack applied then DO confirm failed; final Slack visible then `done` append failed; process crash between SessionEventDO SQL statements) or validates HTTP 429/`Retry-After` recovery.

## Remediation order

1. **C1:** make live message identity/reconciliation durable and idempotent.
2. **C2:** make SessionEventDO terminal persistence a prerequisite of final AG-UI lifecycle commit.
3. **H5:** transaction-wrap SessionEventDO transitions, then add crash/fault-injection tests.
4. **H1:** add exact cross-isolate AG-UI control and gate “Stopped” on it.
5. **H2/H3/H4:** centralize Slack egress rate/size policy and remove silent obligation abandonment.
6. **M1/M2:** wire structured progress/conflation or narrow the documentation and locked rule to the chosen renderer.
7. **M3/M4/L1:** finish status cleanup, compaction, and source-of-truth documentation.
