# OpenTag 2.0 build gap audit

Audit date: 2026-07-13. Branch: `main`. Scope: the merged A1-A5 implementation versus `SPEC.md` sections 7-8, `ARCHITECTURE.md`, `DECISIONS.md`, `GOAL.md`, `implementation-notes.md`, `docs/centaur-port.md`, the production source path, and the read-only Centaur reference.

## Executive verdict

OpenTag 2.0 has a substantial, real durability spine: Events API ingress, durable pre-admission, exact render/effect fences, ConversationStateDO obligations and alarms, SessionEventDO replay/interrupt, sticky overrides, a real Claude Code container, and synthetic quick-action turns all exist. The verification suite passes, but does not exercise the failure boundaries listed below.

It is not complete against the written A1-A5 contract. The four findings classified Critical are:

1. Production does not bind the coding harness and deliberately sends `--claude` work to AG-UI when the harness is unavailable, contrary to the locked no-silent-fallback rule.
2. Live Slack messages have no durable external identity/message reference, so an ambiguously successful live write can later coexist with a recovery answer.
3. The AG-UI path commits final Slack visibility and deletes its obligation before the terminal SessionEventDO event is required; a failed terminal append is swallowed and can wedge the thread as permanently executing.
4. Alarm recovery sends unbounded replay text and discards an obligation after three definitive failures, allowing a long answer to become permanently silent.

The largest Centaur functionality regression is attachments: no late-file repair, no staged large-file tier, prior-thread files are not reconstructed, and the coding harness receives `[attachment omitted]`. The current `docs/centaur-port.md` statement that A1-A5 are implemented should be narrowed to “the core spine landed; attachment, production harness, and live-render subfeatures remain incomplete.”

Every ranked finding below uses `file:line` references. Summary tables point back to those findings and add direct ranges where useful. Findings are ordered by severity, then repair leverage. Every finding ends with a One-line fix: recommendation.

## Critical

### C1. Production coding intent silently falls back because the real harness is not connected

**What is missing/incorrect.** The harness image and HTTP shim are real, but the production bot has no active `HARNESS` binding. Harness routing requires both a Claude harness selection and a binding; otherwise even explicit `--claude` coding work reaches AG-UI. The test suite codifies this fallback. This violates `ARCHITECTURE.md` invariant 8 and `DECISIONS.md` section 15, which require a visible failure for repository coding when the authoritative harness is unavailable.

**Files to inspect.** `edge/wrangler.bot.toml:50-58`; `edge/src/agent-turn.ts:527-534,940-949`; `edge/test/agent-turn-harness.test.ts:456-463`; `ARCHITECTURE.md:307-311,448-465`; `DECISIONS.md:202-208`. The implementation itself is substantive: `containers/harness/Dockerfile:16-54,81-107,160-185`; `edge/workers/sandbox/harness-server.ts:1394-1453`.

**One-line fix.** Connect the production harness service, and reject repository-coding intent before AG-UI whenever that authoritative runtime is unavailable.

### C2. Live/recovery delivery cannot reconcile the same Slack message, so crash ambiguity can duplicate an answer

**What is missing/incorrect.** The planned obligation included a live `messageRef`; the actual schema does not. Normal live posts/placeholders omit a stable `client_msg_id`, while recovery always creates a new post with its own recovery-only ID. If Slack applies a live post/update but the subsequent Durable Object confirmation is lost, the outstanding obligation cannot inspect or update the already-visible message. After the active row expires, recovery is allowed to create a second answer.

**Files to inspect.** `SPEC.md:114-129`; `edge/src/store/schema.ts:70-85`; `edge/src/slack/cloudflare-slack-adapter.ts:755-780,820-837,920-968`; `edge/src/store/active-turn-engine.ts:515-548`; `edge/src/store/conversation-state-do.ts:1134-1162`.

**One-line fix.** Create and durably confirm the live placeholder identity before execution; if creation is ambiguous, stop and reconcile it through a Slack-supported lookup/idempotency mechanism verified by integration test—do not allow recovery to create a new answer until the original `ts` is known absent.

### C3. Final Slack visibility precedes required SessionEventDO terminal persistence

**What is missing/incorrect.** On the normal AG-UI path, the final Slack update atomically deletes the active row and render obligation. Only after `thread.runAgent()` returns does the lifecycle append `done` to SessionEventDO, and that helper catches every error. A transient append failure can therefore leave a visible successful answer but a durable nonterminal execution. SessionEventDO admits only one active execution, so later turns can be rejected indefinitely. This breaks the claim that the durable event log plus visible surface jointly own terminal truth.

**Files to inspect.** `edge/src/slack/cloudflare-slack-adapter.ts:998-1043`; `edge/src/store/active-turn-engine.ts:515-548`; `edge/src/agent-turn.ts:940-949`; `edge/src/slack/turn-lifecycle.ts:129-143,445-449`; `edge/src/store/session-event-do.ts:208-218,277-286`; `ARCHITECTURE.md:448-459`.

**One-line fix.** Make durable terminal persistence a prerequisite of the final Slack commit, or retain a terminalization obligation and active ownership until the `done` event is confirmed.

### C4. Large recovery output can exhaust retries and become permanently silent

**What is missing/incorrect.** Recovery concatenates all matching output events and sends the result directly as Slack `text`; it does not use the 35k/3,000-character/50-block budgeter. Due obligations are deleted before each attempt and reinserted only while the attempt count is below three. A deterministic `msg_too_long`-style rejection therefore consumes the budget and then removes the only recovery record without `failed_size_limit`, a visible small error, or a dead letter.

**Files to inspect.** `edge/src/store/conversation-state-do.ts:388-407,960-1003,1082-1110,1146-1195`; compare the bounded live helper at `edge/src/slack/stream-render.ts:13-75`; `ARCHITECTURE.md:216-236,448-465`.

**One-line fix.** Bound/chunk replay before egress and atomically replace an unrepresentable answer with a small idempotent visible error instead of ever dropping the last obligation silently.

## High

### H1. Stop is durably fenced but cannot actually interrupt cross-isolate AG-UI work

**What is missing/incorrect.** `Stop` is correctly detected before normal routing and durable cancellation prevents later rendering or tool effects. Harness interruption is exact. AG-UI interruption, however, only consults an isolate-local `agentsByConversation` map, swallows abort errors, and returns no acceptance/quiescence proof. A Stop handled by another isolate can mark the turn controlled and post “Stopped” while the request continues consuming compute. This violates the locked exact-runtime continuation even though late user-visible effects are safely suppressed.

**Files to inspect.** `edge/src/worker.ts:160-176`; `edge/src/slack/stop-routing.ts:199-240,296-368`; `edge/src/slack/cloudflare-slack-adapter.ts:173-195,334-347`; `edge/src/store/conversation-state-do.ts:839-872`; `DECISIONS.md:181-193`.

**One-line fix.** Give AG-UI runs a durable exact-execution control endpoint and gate `markCancelControlled`/“Stopped” on definitive interrupt acceptance or quiescence.

### H2. Model/harness flags can be stored and confirmed without changing a runtime

**What is missing/incorrect.** Parsing, stripping, and thread stickiness are real for Claude aliases. But bare `--model <id>` does not select the only supported harness; `--codex` remains accepted although no Codex runtime exists; `-rsn` is descriptive context only; and the AG-UI runtime stays on its environment-selected OpenAI model. A flags-only turn can still say the choice was saved. Combined with C1, much of the advertised selection surface is nominal.

**Files to inspect.** `edge/src/slack/overrides.ts:26-40,56-125`; `edge/src/store/thread-overrides.ts:79-105`; `edge/src/agent-turn.ts:425-438,527-534,773-800,849-861`; `edge/src/harness/client.ts:32-55`; `edge/workers/agent-runtime/src/container.ts:13-39`; `docs/centaur-port.md:241-253`.

**One-line fix.** Make `--model` select the supported Claude harness, reject unavailable provider/reasoning flags visibly, and confirm a preference only after runtime capability is validated.

### H3. Phase A4 attachment hardening is missing end to end

**What is missing/incorrect.** The implementation has one 8 MiB per-file cap, eagerly buffers the full response, base64-embeds supported media, and handles only files present on the first Slack event. There is no size-tier staging, R2/blob handoff, delayed-file correlation, `file_info` repair, or idle retry. Non-text prompt parts are converted to `[attachment omitted]` before the coding harness. This can produce an apparently successful coding answer that never saw the user's image or PDF.

**Files to inspect.** `SPEC.md:364-374`; `edge/src/slack/download-files.ts:23-33,78-159`; `edge/src/slack/cloudflare-slack-adapter.ts:435-444`; `edge/src/agent-turn.ts:388-394,849-861`. Centaur reference: `/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2399-2668`; `/Users/will/Documents/centaur/services/slackbotv2/src/session-api.ts:616-671,1429-1536`.

**One-line fix.** Add durable late-file correlation and bounded small-inline/large-staged tiers, then carry staged attachment references/content through the harness contract.

### H4. Slack rate limiting is not a per-channel discipline and 429/Retry-After is ignored

**What is missing/incorrect.** The raw Slack client performs one fetch and treats `ratelimited` as a definitive generic error. The custom stream has an isolate-local 800 ms interval, while the live AG-UI renderer creates independent message streams and bypasses `conflateChatSdkStream`; multiple continuations/threads can update the same channel concurrently. The dependency also swallows some failed incremental updates. This does not meet GOAL's approximately one update per second per channel rule.

**Files to inspect.** `edge/src/slack/web-api.ts:150-223`; `edge/src/slack/cloudflare-slack-adapter.ts:813-891,902-1031`; `edge/node_modules/@copilotkit/channels-slack/dist/chunked-message-stream.js:15-35,97-132`; `edge/node_modules/@copilotkit/channels-slack/dist/message-stream.js:1-68`; `GOAL.md:20`.

**One-line fix.** Centralize all Slack egress behind a per-channel scheduler that honors HTTP 429/`Retry-After`, preserves idempotent final-render ownership, and applies one shared conflation policy.

### H5. SessionEventDO multi-row transitions are serialized but not crash-atomic

**What is missing/incorrect.** Execute admission inserts the execution and input events as separate commits; `done` append and terminal update are separate; interruption writes its tombstone, done event, and terminal timestamp separately. Durable Object request serialization avoids interleaving but does not prevent a process crash between SQLite statements. Those windows can leave a nonterminal execution without input or inconsistent terminal history, wedging future admission.

**Files to inspect.** `edge/src/store/session-event-do.ts:186-274,289-333,368-397`; compare the transaction-wrapped active-turn transitions in `edge/src/store/active-turn-engine.ts:48-70,515-548`.

**One-line fix.** Add a transaction runner and wrap each execute, done, and interrupt state transition in one SQLite transaction with fault-injection tests.

### H6. GitHub requester attribution is not reliably sourced and its pre-write uniqueness guard is incomplete

**What is missing/incorrect.** OpenTag searches `profile.fields` returned by `users.info`, but does not call `users.profile.get?include_labels=true` and the manifest lacks `users.profile:read`. Slack documents custom profile-field access through `users.profile.get` and label inclusion through `include_labels`; Centaur uses that method. Even when an expected attribution is present, the egress guard only checks that the PR body includes it, so a second conflicting `Prompted by:` line can pass before the PR is created. The stricter exactly-one check runs only after the external write.

**Files to inspect.** `edge/src/slack/web-api.ts:86-140,242-287`; `slack-app-manifest.yaml:16-18,44-60`; `edge/workers/sandbox/src/egress-policy.ts:211-247`; `edge/workers/sandbox/harness-server.ts:1014-1056`; `DECISIONS.md:195-208`; `SPEC.md:376-386`; Centaur `/Users/will/Documents/centaur/services/slackbotv2/src/session-api.ts:957-967`. Current official Slack references as of the audit date: [users.profile.get](https://docs.slack.dev/reference/methods/users.profile.get/) and [users.info](https://docs.slack.dev/reference/methods/users.info/).

**One-line fix.** Add `users.profile:read`, resolve named custom fields through `users.profile.get?include_labels=true`, and require exactly one equal attribution line before authorizing the PR POST.

### H7. The 50-block ceiling is enforced by truncating valid output, not graceful overflow

**What is missing/incorrect.** No payload exceeds 50 blocks, which prevents an invalid Slack request. But the bespoke stream builder replaces the final block with an ellipsis and discards the rest; SPEC and the never-violate GOAL rule require graceful overflow. The test suite explicitly expects a 200k-character response to be truncated. This is deterministic user-visible data loss, so it is High rather than a cosmetic formatting defect.

**Files to inspect.** `edge/src/slack/stream-render.ts:45-68`; `edge/test/slack-stream.test.ts:577-596`; `SPEC.md:224-229`; `GOAL.md:19`.

**One-line fix.** Split overflow at the 50-block boundary into deterministically keyed continuation messages instead of truncating valid output.

### H8. Quick actions acknowledge Slack before durable turn ownership is established

**What is missing/incorrect.** Unlike generic HITL choices, quick actions are scheduled in `waitUntil` and return HTTP 200 immediately. Their durable pre-admission occurs later inside the background handler. If the background task fails before that write, Slack will not retry and the user click is silently lost. This is separate from whether the desired product cards are wired.

**Files to inspect.** `edge/src/worker.ts:291-328`; `edge/src/slack/quick-actions.ts:174-256`; compare the generic durable-choice acknowledgement at `edge/src/worker.ts:306-316`.

**One-line fix.** Complete deterministic identity derivation and durable pre-admission before returning 200, then place only the already-owned execution handoff in `waitUntil`.

## Medium

### M1. `conflateChatSdkStream` is not in the production @mention render path

**What is missing/incorrect.** The conflation implementation is real and used by `adapter.stream()`, but live AG-UI turns use Channels' `createRunRenderer()` instead. Text still streams through the dependency, so the original “no live streaming” defect is partly fixed; the missing part is the promised shared conflation path and structured `task_update`/`plan_update` rendering. Harness output is buffered to one final Slack post.

**Files to inspect.** `edge/src/slack/conflate.ts:29-109`; `edge/src/slack/cloudflare-slack-adapter.ts:813-891,902-1031`; `edge/src/agent-turn.ts:881-918,940-949`; `implementation-notes.md:342-349`; `docs/centaur-port.md:278-282`.

**One-line fix.** Route AG-UI and harness deltas through one fenced conflation-aware renderer, including task/plan chunks, or explicitly redefine and test the Channels renderer as the chosen equivalent.

### M2. Progress is a static status, and status failure can abort a turn

**What is missing/incorrect.** The initial and final status calls use the correct root `thread_ts`, and clearing occurs in `finally`. But the only status is `Thinking…`; tool status is disabled and no activity/task summary updates are wired. More importantly, the initial `setStatus` is awaited outside a best-effort catch, so a cosmetic API or rate-limit failure enters the main error path before model execution. Alarm-resumed Stop also posts “Stopped” without clearing stale status.

**Files to inspect.** `edge/src/slack/turn-lifecycle.ts:200-216,385-392,477-489`; `edge/src/slack/cloudflare-slack-adapter.ts:980-991`; `edge/src/slack/web-api.ts:198-223`; `edge/src/store/conversation-state-do.ts:908-948`.

**One-line fix.** Treat status as non-fatal, add fenced/coalesced activity summaries, and persist an idempotent status-clear step in Stop continuation.

### M3. SessionEventDO is not the canonical conversational reconstruction source

**What is missing/incorrect.** SessionEventDO genuinely owns execution dedup, output replay, and exact interrupts. The AG-UI object/history still lives in the isolate-local `agentsByConversation` map. After isolate loss, a fresh agent is reconstructed from a text-only Slack/durable transcript, not from canonical tool/result/attachment events. The event DO is therefore a delivery source of truth, not a complete session source of truth.

**Files to inspect.** `edge/src/slack/cloudflare-slack-adapter.ts:169-195`; `edge/src/store/session-event-do.ts:39-69,186-397`; `edge/src/agent-turn.ts:803-824`; `ARCHITECTURE.md:313-315`.

**One-line fix.** Persist a canonical rich conversation transcript—including tool results and attachment references—and rebuild AG-UI from it while treating the isolate map only as a cache.

### M4. Follow-up history loses files and block/attachment-only content

**What is missing/incorrect.** History replay maps Slack messages to `text`, timestamps, bot flag, and user only; it ignores files, blocks, and attachments. A follow-up such as “compare that PDF with this one” loses the earlier artifact after a fresh run. Centaur reconstructs display text and prior attachment references.

**Files to inspect.** `edge/src/slack/cloudflare-slack-adapter.ts:1108-1140`; `edge/src/slack/ingress-normalize.ts:53-75,147-220`; Centaur `/Users/will/Documents/centaur/services/slackbotv2/src/slack-display-text.ts:14-68,150-368`; `/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2766-2873`.

**One-line fix.** Normalize history through a bounded block/attachment display extractor and durably persist/re-stage attachment references for follow-up turns.

### M5. Interactive synthetic-turn plumbing exists, but the intended cards are mostly unwired

**What is missing/incorrect.** `quick_*` clicks correctly derive stable identities, resolve the clicking user, and re-enter normal ingress once their handler runs. The only live product card is the Linear IssueList retry button. `buildQuickDeployCard()` has no production caller, and research Dig-deeper/Export or Retry/Export cards do not exist. The acknowledgement-before-admission correctness issue is ranked separately as H8.

**Files to inspect.** `edge/src/slack/quick-actions.ts:134-267`; `edge/src/worker.ts:273-328`; `edge/src/components/cards.ts:131-169`; `edge/src/slack/quick-card.ts:61-147`; `implementation-notes.md:191-200`.

**One-line fix.** Wire research/artifact cards to final output and durably deduplicate their artifact/action identities per thread.

### M6. Delivery observability is incomplete and health is static metadata

**What is missing/incorrect.** JSON lifecycle logs and `fallback_sent`/`error_visible` exist. Required `streamed`, `answer_visible`, and `failed_size_limit` outcomes do not, nor is there an Analytics Engine binding. `/health` returns a hard-coded payload and does not probe StateStore or SessionEventDO, so it can be green while a binding is unusable.

**Files to inspect.** `SPEC.md:300-307`; `edge/src/slack/turn-lifecycle.ts:318,423-466`; `edge/src/store/conversation-state-do.ts:1091-1110,1208-1214`; `edge/src/worker.ts:43-53`; `docs/operations.md:249-288`.

**One-line fix.** Emit the full outcome taxonomy at confirmed transitions and either add bounded binding checks to health or rename it as static readiness metadata.

### M7. Session durability contracts remain optional at the type/runtime boundary

**What is missing/incorrect.** Production configuration binds SessionEventDO and normal lifecycle calls pass stable forwarded IDs. But `SESSION_EVENTS` and `forwardedMessageId` are optional, and missing `SESSION_EVENTS` silently returns “accepted.” A misconfigured deployment therefore loses a supposedly invariant durability/dedup layer without failing readiness.

**Files to inspect.** `edge/src/env.ts:14-21`; `edge/src/slack/turn-lifecycle.ts:105-122,217-228`; `edge/src/store/session-event-do.ts:186-190,239-249`; `edge/wrangler.bot.toml:22-34`.

**One-line fix.** Make the binding and forwarded ID required, fail readiness when absent, and remove accept-without-session behavior.

### M8. Centaur's bounded transient handoff retries were dropped

**What is missing/incorrect.** Centaur retries transient session handoff at 5, 30, and 120 seconds. OpenTag catches a runtime failure once, posts a manual-retry error if possible, and otherwise relies on render recovery; it does not retry the not-yet-started execution automatically.

**Files to inspect.** `edge/src/slack/turn-lifecycle.ts:464-476`; Centaur `/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:630-673,978-1047`.

**One-line fix.** Persist a bounded exact-execution handoff schedule in the owning DO and retry only before any runtime side effect or output has been confirmed.

## Low

### L1. No session viewer or first-turn console link exists

**What is missing/incorrect.** The planned `edge/src/slack/session-link.ts`, authenticated event view, and first-assistant-message context block are absent. The port ledger explicitly deferred this, so it is an operator/debug UX gap rather than a turn-correctness defect.

**Files to inspect.** `SPEC.md:69-73,426,431-452`; `docs/centaur-port.md:257-270,283-284`; Centaur `/Users/will/Documents/centaur/services/slackbotv2/src/console-session-link.ts:79-125`.

**One-line fix.** Expose an authenticated read-only SessionEventDO view and add a once-per-thread context link showing the effective runtime/model.

### L2. Source-of-truth comments and completion documentation overstate the implementation

**What is missing/incorrect.** SessionEventDO comments still name old KV executing/interrupted slots although SQL is authoritative. `docs/centaur-port.md` calls all A1-A5 implemented despite the production harness, attachments, metrics, artifact-card, and live-render gaps above.

**Files to inspect.** `edge/src/store/session-event-do.ts:13-19,486-511`; `implementation-notes.md:251-256`; `docs/centaur-port.md:1-3,66,272-286`.

**One-line fix.** Update comments to name SQL as authoritative and label A1-A5 as core-spine complete with the remaining subfeatures explicitly open.

### L3. Session/event dedup history has no retention policy

**What is missing/incorrect.** Durable exact dedup is strong, but `events`, `executions`, and cancellation tombstones have no compaction. Long-lived DM/thread DO databases grow monotonically; the earlier bounded-ID concept was explicitly deferred. This is an operational risk, not a demonstrated Section 7 correctness failure.

**Files to inspect.** `edge/src/store/session-event-do.ts:39-69,205-249,336-397`; `implementation-notes.md:294-299`.

**One-line fix.** Add cursor-safe compaction that preserves active executions and a bounded recent dedup/tombstone window.

## SPEC section 7 coverage

| Canonical gap | Audit verdict | Primary finding |
| --- | --- | --- |
| No live streaming | Partial: AG-UI text streams through Channels; OpenTag conflation/structured progress is not live, and harness output is buffered | M1, H4 |
| No delivery guarantee | Not closed: obligations/alarms are real, but live identity, terminal ordering, bounded recovery, and final retry ownership are unsafe | C2, C3, C4 |
| No progress visibility | Partial: correct-root `Thinking…` is live; activity/task progress and resilient best-effort behavior are missing | M2 |
| No stop/interrupt | Partial: pre-routing Stop, exact durable fencing, and harness interrupt work; cross-isolate AG-UI interruption does not | H1 |
| No model/harness selection | Partial: parsing/stickiness work, but several flags are nominal and production lacks the selected harness | H2, C1 |
| Isolate-local agent state | Partial: durable execution/replay exists, but rich AG-UI conversation state remains isolate-local/text-reconstructed | M3, M4 |
| No real coding harness | Source-complete but production-disconnected, with prohibited silent fallback | C1 |
| Thin attachment handling | Not closed: no tiers, staging, late-file repair, history restoration, or harness transport | H3, M4 |
| No interactive follow-up cards | Plumbing works; most intended research/artifact cards are not posted, and clicks are acknowledged before durable ownership | M5, H8 |
| No observability | Partial structured logs only; required delivery outcomes and real health/analytics are absent | M6 |
| No session viewer / console link | Unimplemented/deferred | L1 |
| No requester→GitHub identity | Partial and unreliable for custom fields; PR pre-write uniqueness is unsafe | H6 |

## Centaur functionality not carried forward

The following are material user-facing or operational behaviors, not intentionally excluded Kubernetes/Postgres/warm-pool architecture:

- **Late Slack file repair.** Centaur correlates fileless mentions with delayed file events, hydrates placeholders, waits for thread idle, and creates a synthetic file turn; OpenTag only sees files on the initial event (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2399-2668`; `edge/src/slack/cloudflare-slack-adapter.ts:435-444`).
- **Large/staged and historical attachments.** Centaur supports much larger inline/staged inputs and restores thread attachment context; OpenTag caps at 8 MiB, eagerly base64-encodes, loses prior files, and omits attachments from the harness (`/Users/will/Documents/centaur/services/slackbotv2/src/session-api.ts:616-671,1429-1536`; `edge/src/slack/download-files.ts:23-33,117-159`; `edge/src/agent-turn.ts:388-394`).
- **Rich display-text reconstruction.** Centaur extracts text/links from Block Kit, rich text, and legacy attachments; OpenTag history is primarily plain `text` (`/Users/will/Documents/centaur/services/slackbotv2/src/slack-display-text.ts:14-68,150-368`; `edge/src/slack/cloudflare-slack-adapter.ts:1108-1140`).
- **Dynamic progress.** Centaur exposes activity summaries/task progress; OpenTag uses static `Thinking…`, disables tool status, and does not render task/plan chunks (`edge/src/slack/turn-lifecycle.ts:385-392`; `edge/src/slack/cloudflare-slack-adapter.ts:980-991`; `docs/centaur-port.md:278-282`).
- **Live coding output.** The OpenTag harness client has an `onText` hook but the caller buffers all output into one final post (`edge/src/harness/client.ts:32-55,413-447`; `edge/src/agent-turn.ts:849-918`).
- **Automatic artifact follow-ups.** Centaur scans final output and posts/deduplicates action cards; OpenTag's generalized card builder has no production call site (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2237-2269`; `edge/src/slack/quick-card.ts:61-147`; `implementation-notes.md:191-200`).
- **Transient session-handoff retry.** Centaur retries bounded transient handoff failures; OpenTag immediately asks the user to retry (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:630-673,978-1047`; `edge/src/slack/turn-lifecycle.ts:464-476`).
- **Session console and stronger operational metrics.** OpenTag intentionally deferred the viewer and omits three required delivery outcomes (`docs/centaur-port.md:257-270,283-284`; `SPEC.md:300-307`; `edge/src/worker.ts:43-53`).
- **Requester custom-field lookup.** Centaur calls `users.profile.get` with labels; OpenTag reads `users.info` and assumes named field metadata is present (`/Users/will/Documents/centaur/services/slackbotv2/src/session-api.ts:957-967`; `edge/src/slack/web-api.ts:86-140,242-287`).

Intentional locked divergences—Cloudflare instead of Kubernetes/Postgres, no warm pool, GitHub-only outbound policy, and no Amp/Codex provider matrix—were not scored as defects by themselves. Misleading flags or broken locked guarantees caused by those choices were scored.

## GOAL house-rule audit

| Rule | Verdict | Evidence |
| --- | --- | --- |
| Events API only | Pass: production routes are Events API; no Socket Mode bot path. | `edge/src/worker.ts:146-209,273-329`; `slack-app-manifest.yaml:73-90` |
| Durable Objects for durability | Partial: active state, choices, sessions, and memory are DO-backed; AG-UI runtime state remains isolate-local and SessionEventDO can be silently absent. | `edge/wrangler.bot.toml:10-34`; `edge/src/slack/cloudflare-slack-adapter.ts:169-195`; `edge/src/slack/turn-lifecycle.ts:105-122` |
| Never duplicate / exact IDs | Fail on ambiguous external Slack create; internal stable IDs and admission dedup are otherwise strong. | C2; `edge/src/request-context.ts:76-113`; `edge/src/store/session-event-do.ts:205-249` |
| 50-block limit with graceful overflow | Partial: hard ceiling enforced, but valid overflow is truncated instead of continued. | H7; `edge/src/slack/stream-render.ts:45-68` |
| Rate-limit discipline | Fail: no shared per-channel scheduler and no 429/Retry-After handling; production bypasses OpenTag conflation. | H4; `GOAL.md:20` |
| HITL gates | Partial: durable generic choices and remote-git approval are real; H6 permits conflicting attribution through the pre-write check. | `edge/src/worker.ts:306-316`; `DECISIONS.md:195-208`; `edge/workers/sandbox/src/egress-policy.ts:211-247` |
| Centaur untouched | No writes were made by this audit; the reference worktree remained pre-existing dirty (`M AGENTS.md`, untracked `docs/public/md/capabilities.md`). | Audit command: `git -C /Users/will/Documents/centaur status --short` |
| Typecheck/tests | Pass in the audited source/dependency state; see verification below. | Verification table below |

## SPEC section 8 file census

Eleven of twelve planned net-new files exist. `edge/src/slack/session-link.ts` is the only missing file.

| Planned file | Verdict |
| --- | --- |
| `edge/src/slack/conflate.ts` | Present; not on main live render path. |
| `edge/src/slack/overrides.ts` | Present and called; semantic gaps in H2. |
| `edge/src/slack/stop-command.ts` | Present and called before routing. |
| `edge/src/slack/quick-card.ts` | Present; generalized production posting hook missing. |
| `edge/src/slack/quick-actions.ts` | Present and routes synthetic normal turns. |
| `edge/src/slack/session-link.ts` | **Missing.** |
| `edge/src/slack/chunk-types.ts` | Present. |
| `edge/src/store/session-event-do.ts` | Present, registered, used, and tested. |
| `edge/workers/sandbox/harness-server.ts` | Present; real HTTP/Claude Code shim. |
| `edge/workers/sandbox/tool-host.ts` | Present; optional bridge. |
| `containers/harness/Dockerfile` | Present; real pinned toolchain image. |
| `containers/harness/SYSTEM_PROMPT.md` | Present. |

The seven “substantially modified” entries from `SPEC.md:455-464` have the following census:

| Planned modified file | Present/wired verdict |
| --- | --- |
| `edge/src/slack/cloudflare-slack-adapter.ts` | **Present and live.** Normal ingress, Channels live rendering, fences, status, and history are wired; custom `stream()` conflation is not the main @mention path (M1/H4). See `edge/src/slack/cloudflare-slack-adapter.ts:813-1031`. |
| `edge/src/store/conversation-state-do.ts` | **Present and live.** Real obligations, alarms, Stop continuation, replay, and recovery exist; reconciliation/retry/size gaps are C2/C4. See `edge/src/store/conversation-state-do.ts:442-502,833-1003,1008-1214`. |
| `edge/src/bot-engine.ts` | **Present and live, responsibilities split.** It builds the bot/adapter and delegates status, Stop-safe lifecycle, and obligations to `turn-lifecycle.ts`/`stop-routing.ts`; ordinary mentions call the lifecycle at `edge/src/bot-engine.ts:288-296`. |
| `edge/src/agent-turn.ts` | **Present and live.** Overrides/requester context/harness routing are called; production fallback and attachment gaps are C1/H2/H3. See `edge/src/agent-turn.ts:425-438,527-534,773-918,940-949`. |
| `edge/src/worker.ts` | **Present and live.** Stop is routed before bot ingress and interactions split quick actions from durable generic HITL; quick acknowledgement gap is H8. See `edge/src/worker.ts:146-209,273-329`. |
| `edge/src/tasks/runtime.ts` | **Present but only partially matches the planned role.** It forwards an effective model to the research orchestrator (`edge/src/tasks/runtime.ts:44-89`); A5 container model passthrough instead occurs via `agent-turn.ts` and `harness/client.ts`, and several selection flags remain nominal (H2). |
| `wrangler.toml` | **Represented as `edge/wrangler.toml` plus production `edge/wrangler.bot.toml`.** Both bind/migrate SessionEventDO (`edge/wrangler.toml:24-40`; `edge/wrangler.bot.toml:22-34`); the production harness service remains commented (`edge/wrangler.bot.toml:50-58`). There is no root-level `wrangler.toml`, consistent with `edge/` being the deployable target. |

## Verification run on main

Run on 2026-07-13 PDT at commit `920825c9175afb7d21564273a74689cd52e226b7`, branch `main`, using the installed workspace dependency state. The only OpenTag worktree addition at final report validation was untracked `goal-outputs/`; this resumed audit did not run `npm ci` or deploy anything.

| Command | Result |
| --- | --- |
| `cd edge && npm run typecheck` | **PASS**, `tsc --noEmit`, exit 0 |
| `cd edge && npm test` | **PASS**, 39 files / 559 passed |
| `cd edge && npm run test:e2e` | **PASS**, 1 workerd file / 24 passed |
| `cd edge/workers/sandbox && npm run typecheck` | **PASS**, exit 0 |

Not run: Docker image build, deployed Worker/container smoke test, live Slack interaction, real Claude invocation, or real clone/push/PR. No Worker or Container was deployed.

The green suites do not cover the decisive failure boundaries: Slack-applied/live-confirmation-lost ambiguity, final Slack visible/SessionEventDO terminal append failed, crash between SessionEventDO SQL statements, over-limit obligation recovery, cross-isolate AG-UI Stop, late Slack file delivery, actual attachment delivery into the harness, multiple same-channel stream rate limiting, or duplicate `Prompted by:` lines before PR creation.

## Confirmed-correct areas

- Stop detection is called before normal routing, and exact durable render/effect fences suppress late output and mutations (`edge/src/worker.ts:160-176`; `edge/src/slack/cloudflare-slack-adapter.ts:271-299`; `edge/src/tools/index.ts:62-145`).
- Durable pre-admission uses stable Slack-derived IDs; active turn plus initial obligation is transactional (`edge/src/request-context.ts:76-113`; `edge/src/slack/pre-admit-turn.ts:118-157`; `edge/src/store/active-turn-engine.ts:56-116`).
- ConversationStateDO has real obligation rows, alarms, cursor replay, exact execution filtering, and stable recovery IDs (`edge/src/store/conversation-state-do.ts:388-407,442-502,967-1214`).
- SessionEventDO exists in production config and implements execute/dedup/replay/interrupt; targeted tests exercise those methods (`edge/wrangler.bot.toml:22-34`; `edge/src/store/session-event-do.ts:186-397`; `edge/test/session-event-do.test.ts:121-486`).
- Correct-root `thread_ts` selection for `Thinking…` and normal cleanup is implemented (`edge/src/slack/turn-lifecycle.ts:200-216,385-392,477-489`).
- Claude alias parsing/stripping/stickiness works when the Claude harness is selected and available (`edge/src/slack/overrides.ts:56-125`; `edge/src/store/thread-overrides.ts:79-105`; `edge/test/thread-overrides.test.ts:74-150`).
- The container is a real non-root Claude Code process wrapper with clone/reuse, NDJSON persistence, interruption, egress controls, and git/PR postconditions (`containers/harness/Dockerfile:16-54,81-107,160-185`; `edge/workers/sandbox/harness-server.ts:805-925,1014-1056,1394-1453`).
- Quick-action handlers use the clicking Slack identity and re-enter normal ingress after invocation (`edge/src/slack/quick-actions.ts:174-267`; `edge/test/quick-actions.test.ts:194-252`). H8 qualifies acknowledgement durability.
- All audited block builders enforce an absolute 50-block maximum (`edge/src/slack/stream-render.ts:13-68`; `edge/src/slack/quick-card.ts:35-43,99-147`); H7 is loss of overflow, not a 51-block request.

## Recommended repair order

1. Connect the production harness and prohibit silent coding fallback (C1).
2. Make live message identity/reconciliation durable and reorder terminal persistence ahead of final visibility (C2-C3).
3. Bound recovery and retain terminal retry/dead-letter ownership (C4).
4. Add exact cross-isolate AG-UI control and transaction-wrap SessionEventDO (H1, H5).
5. Centralize Slack rate/size/idempotency policy (H4, H7), then finish attachments end to end (H3, M4).
6. Make quick-action ownership and override/identity claims truthful before richer progress/cards/metrics (H8, H2, H6, M1-M6).
