# Independent Centaur parity and completeness audit

Date: 2026-07-13
Scope: current OpenTag working tree, `SPEC.md` sections 7-8, `GOAL.md` house rules, `ARCHITECTURE.md`, `DECISIONS.md`, `implementation-notes.md`, `docs/centaur-port.md`, `docs/operations.md`, and the read-only Centaur reference at `/Users/will/Documents/centaur/`.

## Bottom line

The implementation is substantially stronger than Centaur around exact Stop, active-turn/effect fences, and Durable Object ownership, and its current tests/typechecks are green. It is not complete against the written port contract. The most serious defect is in the supposedly never-silent recovery path: replayed output is unbounded at the Slack boundary and a deterministic size rejection consumes the finite retry budget, after which the obligation disappears without a visible fallback. The main live Slack post path also lacks stable `client_msg_id` values, so an ambiguous successful post cannot be retried idempotently and can later coexist with a recovery post.

Attachment behavior is the largest Centaur feature regression: no late-file repair, no staged large-file transport, non-text attachments are deliberately replaced with `[attachment omitted]` for the coding harness, and replayed Slack history drops file content. The port ledger acknowledges some other incompleteness (buffered harness output, no artifact-card posting hook, no event viewer), but its blanket “implemented through phases A1-A5” status is too strong.

No intentional locked divergence is treated as a bug below: Kubernetes/CRDs, ParadeDB/Postgres, warm pools, the Rails console, arbitrary-protocol NetworkPolicy, Amp/Codex provider parity, Git hosts other than GitHub, and opt-in deployment of the harness remain accepted exclusions in `docs/centaur-port.md:241-255,272-286` and `DECISIONS.md:11-68,195-208`.

## Findings

### Critical

#### C1. A long recovered answer can exhaust retries and become permanently silent

**Evidence.** Recovery concatenates replayed output and sends it directly to `postFallback()` (`edge/src/store/conversation-state-do.ts:1091-1101`). `postFallback()` places that unbounded string directly in Slack's `text` form field (`edge/src/store/conversation-state-do.ts:1146-1162`); unlike the live stream helper, it applies neither the 35,000-character fallback cap nor chunking. A definitive Slack rejection throws (`edge/src/store/conversation-state-do.ts:1184-1195`). The row was deleted before the attempt and is reinserted only while `attempt + 1 < 3`; on the third rejection it is simply gone (`edge/src/store/conversation-state-do.ts:967-1003`). Centaur explicitly truncates its replay fallback before posting (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:1394-1400`). The current behavior contradicts `ARCHITECTURE.md:216-236` (recovery posts an answer or explicit retry/error and clears only after confirmation) and invariant 9, “All Block Kit and text output is bounded” (`ARCHITECTURE.md:448-465`).

**Severity rationale.** This defeats the core never-silent guarantee on exactly the large/long turns most likely to need crash recovery. The failure is deterministic once the payload exceeds Slack's accepted size.

**One-line fix.** Bound/chunk recovered text before `chat.postMessage` and, on `msg_too_long`, atomically replace it with a small idempotent error-visible fallback rather than consuming and dropping the obligation.

### High

#### H1. Live Slack creates are not externally idempotent, so ambiguous success can duplicate on recovery

**Evidence.** Normal `post()` creates messages without `client_msg_id` (`edge/src/slack/cloudflare-slack-adapter.ts:755-780`), as does the initial streaming placeholder (`edge/src/slack/cloudflare-slack-adapter.ts:820-831`). The active-turn fence correctly retains its token on ambiguous network failure (`edge/src/slack/active-turn-registry.ts:121-131`), but it cannot tell Slack to replay the same create. Recovery later uses a newly derived obligation `client_msg_id` (`edge/src/store/conversation-state-do.ts:1146-1151`). Thus, if Slack applied the original unkeyed request but the response was lost, the later keyed recovery post is a second visible message. Only Stop acknowledgements and obligation fallbacks currently carry stable `client_msg_id` values (repo-wide production call sites at `edge/src/slack/stop-routing.ts:379` and `edge/src/store/conversation-state-do.ts:922,1149`).

**Severity rationale.** This violates GOAL house rule 3 (`GOAL.md:18`) and the exact-render design claim that ambiguous delivery remains safely retryable (`ARCHITECTURE.md:203-210`). Internal execution dedup cannot deduplicate an already-applied external Slack mutation.

**One-line fix.** Derive and persist a stable per-execution/per-message-role (and continuation ordinal) `client_msg_id`, use it on the first live `chat.postMessage`, and reuse exactly that ID during recovery.

#### H2. Phase A4 attachment hardening was not implemented, and the coding harness drops attachments

**Evidence.** The phase contract required size-tier staging and a 15-second late-file repair (`SPEC.md:364-374`). Current ingress downloads at most five files and hard-skips each file above 8 MiB (`edge/src/slack/download-files.ts:23-33,78-115`); there is no staged/chunked tier. Centaur accepted inline attachments up to 100 MiB and staged large base64 inputs into chunks (`/Users/will/Documents/centaur/services/slackbotv2/src/session-api.ts:616-650,1429-1450,1513-1536`). More seriously, OpenTag converts every non-text prompt part to the literal `[attachment omitted]` before invoking the harness (`edge/src/agent-turn.ts:388-394,849-861`).

Centaur also repairs Slack's delayed file webhook: it remembers fileless mentions, matches a subsequent file within 15 seconds, hydrates `files.info` placeholders, waits for the thread to become idle, and runs a synthetic file turn (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2399-2480,2492-2548,2589-2668`). OpenTag only processes files already present on the current event (`edge/src/slack/cloudflare-slack-adapter.ts:435-444`); there is no pending-mention/late-file implementation anywhere under `edge/src`.

**Severity rationale.** Users can receive an apparently successful coding turn that never saw the supplied image/PDF, while delayed Slack files and ordinary 8-100 MiB files are lost or reduced to a note. This is correctness, not presentation polish.

**One-line fix.** Add durable late-file correlation plus size-tier staging, and extend the harness wire contract to carry staged attachment metadata/content instead of flattening non-text parts to `[attachment omitted]`.

#### H3. The production AG-UI renderer bypasses the promised conflation layer and throttles per message, not per channel

**Evidence.** The custom `stream()` path uses `conflateChatSdkStream()` and an 800 ms floor (`edge/src/slack/cloudflare-slack-adapter.ts:808-891`), but the production AG-UI path calls Channels' `createRunRenderer()` directly (`edge/src/slack/cloudflare-slack-adapter.ts:902-1031`; the turn invokes it through `thread.runAgent()` at `edge/src/agent-turn.ts:940-949`). No conflation wrapper is supplied there. The resolved Channels implementation creates a separate `MessageStream` for every 3,500-character continuation (`edge/node_modules/@copilotkit/channels-slack/dist/chunked-message-stream.js:15-35,97-132`); each stream independently defaults to 800 ms and swallows failed updates (`edge/node_modules/@copilotkit/channels-slack/dist/message-stream.js:1-13,46-68`). A long response can therefore issue N updates per 800 ms to one channel. This contradicts the explicit “do not bypass” rule (`GOAL.md:20`) and the architecture claim that high-frequency structured chunks pass through conflation (`ARCHITECTURE.md:421-435`).

**Severity rationale.** Long/multi-message outputs are the exact case where Slack rate pressure is highest; swallowed 429/update failures can leave stale or partial user-visible content while the lifecycle continues.

**One-line fix.** Put the AG-UI subscriber behind a single per-channel conflation/rate-limit scheduler (including all continuation messages) and propagate terminal update failure into the render obligation instead of swallowing it.

### Medium

#### M1. Slack history replay loses prior file contents and block/attachment-only message text

**Evidence.** Every AG-UI run is fresh and depends on live Slack plus durable transcript injection (`edge/src/agent-turn.ts:803-824`). Yet `getMessages()` maps history to only `m.text`, timestamp, bot flag, and user; it ignores `files`, `blocks`, and `attachments` (`edge/src/slack/cloudflare-slack-adapter.ts:1108-1140`). Current ingress likewise requires/uses the raw `text` field except for files (`edge/src/slack/ingress-normalize.ts:53-75,147-220`). Centaur reconstructs text from Block Kit, rich text, legacy attachments, and links when plain text is absent (`/Users/will/Documents/centaur/services/slackbotv2/src/slack-display-text.ts:14-68,150-235,276-368`) and serializes prior thread attachments (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2766-2807,2810-2873`).

**Severity rationale.** Follow-ups such as “compare that PDF with this one” lose the earlier artifact after an isolate/run boundary, and messages generated primarily through blocks can become blank or context-poor.

**One-line fix.** Normalize Slack history through a bounded Centaur-style display-text/link extractor and persist/re-stage attachment references for follow-up turns.

#### M2. The 50-block hard cap passes, but graceful overflow is implemented as data loss

**Evidence.** `buildMrkdwnBlocks()` slices to 50 blocks and changes the final block to an ellipsis (`edge/src/slack/stream-render.ts:45-68`). That prevents an invalid request, but does not “overflow to a second message” as required by `SPEC.md:224-229` and GOAL house rule 4 (`GOAL.md:19`). The current test deliberately expects a 200k-character response to be truncated (`edge/test/slack-stream.test.ts:577-596`).

**Severity rationale.** Valid agent output beyond roughly 150k characters is silently discarded; the user cannot retrieve the overflow from Slack.

**One-line fix.** Split at the 50-block boundary into deterministically keyed continuation messages and reserve the last block only for a continuation marker, not truncation.

#### M3. Quick artifact cards exist only as dead production code

**Evidence.** Centaur scans final text, deduplicates sites already posted, posts the card, and persists the site IDs (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:2237-2269`). OpenTag defines the generalized builder (`edge/src/slack/quick-card.ts:61-147`) but has no production call site. This is explicitly admitted in `implementation-notes.md:191-200`; only `IssueList`'s Retry button is live (`edge/src/components/cards.ts:148-168`). The port ledger softens this to “Artifact-domain posting hook remains optional” (`docs/centaur-port.md:257-270`).

**Severity rationale.** The synthetic-turn plumbing works, but the headline Re-generate/View files/Delete UX never appears automatically for artifact URLs.

**One-line fix.** Add a configured artifact-domain final-render hook that scans, posts through the exact render fence, and durably deduplicates artifact IDs per thread.

#### M4. Centaur's transient session-handoff retries were dropped

**Evidence.** Centaur schedules retryable handoff failures at 5 s, 30 s, and 120 s, preserves dedup, and clears status or emits a visible error after exhaustion (`/Users/will/Documents/centaur/services/slackbotv2/src/index.ts:131-136,630-673,978-1047`). OpenTag's lifecycle catches an agent/runtime error once and immediately posts “retry in a few seconds”; if that post also fails, it waits for obligation recovery (`edge/src/slack/turn-lifecycle.ts:464-476`). There is no durable or in-request automatic execution handoff retry.

**Severity rationale.** The system is never-silent when the error card lands, but a transient service-binding/runtime failure turns into manual user work and loses Centaur's resilience.

**One-line fix.** Persist a bounded exact-execution handoff retry schedule in the owning DO and retry only before any runtime side effect/output is confirmed.

#### M5. The promised delivery metric taxonomy is incomplete and the health route is a static assertion

**Evidence.** SPEC's minimum taxonomy includes `streamed`, `answer_visible`, `error_visible`, and `failed_size_limit` (`SPEC.md:300-307`). OpenTag logs turn lifecycle plus `fallback_sent`/`error_visible`, but has no `streamed`, `answer_visible`, or `failed_size_limit` producer under `edge/src`; `docs/operations.md:262-288` likewise omits them while `docs/centaur-port.md:66` says the minimum counters are implemented. The `/health` handler returns a hard-coded store/product/spine payload and does not call any binding; its spine even omits `SESSION_EVENTS` (`edge/src/worker.ts:43-53`). `docs/operations.md:249-260` describes it as the bot/StateStore health check, while the real store exercise is the separately admin-authenticated `/debug/store` route (`edge/src/worker.ts:55-71`).

**Severity rationale.** Operators can get a green health response while the session DO or state binding is unusable and cannot quantify live-vs-fallback delivery or size-limit failures.

**One-line fix.** Emit the full pinned outcome taxonomy at final confirmation and make health perform bounded non-mutating binding checks (or rename it readiness metadata and document `/debug/store` as the only state probe).

#### M6. `forwardedMessageId` and `SESSION_EVENTS` remain optional in core contracts

**Evidence.** Production lifecycle correctly derives and passes both exact IDs (`edge/src/slack/turn-lifecycle.ts:217-228,340-345,417-422`), and both wrangler configs register `SESSION_EVENTS` (`edge/wrangler.toml:24-40`; `edge/wrangler.bot.toml:22-34`). However, the Env type still declares the binding optional with obsolete “later phase” fallback prose (`edge/src/env.ts:14-21`), `admitSessionExecution()` silently returns accepted when it is missing (`edge/src/slack/turn-lifecycle.ts:105-122`), and `SessionEventDO.execute()` makes `forwardedMessageId` optional and only checks it conditionally (`edge/src/store/session-event-do.ts:186-190,239-249,493-498`).

**Severity rationale.** Current production configuration is safe, but the allegedly never-violable durability/dedup invariants are not enforced by the runtime/type boundary and can silently disappear in a misconfigured or alternate deployment.

**One-line fix.** Make `SESSION_EVENTS` and `forwardedMessageId` required, fail readiness/startup when the binding is absent, and remove the accept-without-session fallback.

#### M7. Coding-harness output is buffered to one final post rather than streamed

**Evidence.** The harness client exposes `onText` and receives/persists each output delta (`edge/src/harness/client.ts:32-55,413-447`) but `agent-turn.ts` does not pass the hook and posts only `harnessResult.text` after completion (`edge/src/agent-turn.ts:849-861,881-918`). The port ledger acknowledges this limit (`docs/centaur-port.md:272-282`).

**Severity rationale.** Long coding turns lose Centaur's progressive feedback and concentrate size/failure risk into one final Slack post.

**One-line fix.** Feed `onText` into the same fenced, conflated incremental renderer and make the final update the terminal confirmation point.

### Low / census-only divergence

#### L1. `edge/src/slack/session-link.ts` is the only missing SPEC section 8 file

The file is absent, but this should not be reopened as a defect while the locked product choice remains “Console: None; event viewer future” (`docs/centaur-port.md:259-270,272-284`). SPEC's original low-effort console-link gap (`SPEC.md:426`) was superseded by that accepted architecture. If a viewer is later added, restore the first-assistant-message context link pattern from `/Users/will/Documents/centaur/services/slackbotv2/src/console-session-link.ts:79-125`.

## SPEC.md section 8 net-new file census

Section 8 lists 12 expected files (`SPEC.md:431-453`). Eleven are present.

| Expected file | Verdict | Evidence / note |
| --- | --- | --- |
| `edge/src/slack/conflate.ts` | Present | 110-line near-verbatim port; implementation header and exported algorithm at `edge/src/slack/conflate.ts:1-110`. |
| `edge/src/slack/overrides.ts` | Present | `edge/src/slack/overrides.ts:1-141`. |
| `edge/src/slack/stop-command.ts` | Present | 27-line port at `edge/src/slack/stop-command.ts:1-27`. |
| `edge/src/slack/quick-card.ts` | Present | Builder exists at `edge/src/slack/quick-card.ts:1-148`; production posting hook is missing (M3). |
| `edge/src/slack/quick-actions.ts` | Present | Synthetic-turn path at `edge/src/slack/quick-actions.ts:144-267`. |
| `edge/src/slack/session-link.ts` | **Missing** | Intentional/superseded console omission; see L1. |
| `edge/src/slack/chunk-types.ts` | Present | Three-way chunk union at `edge/src/slack/chunk-types.ts:1-18`. |
| `edge/src/store/session-event-do.ts` | Present | Engine and DO RPC wrapper at `edge/src/store/session-event-do.ts:121-438,440-551`. |
| `edge/workers/sandbox/harness-server.ts` | Present | Full container-side server (1,700+ lines); entry contract is in `edge/workers/sandbox/harness-server.ts`. |
| `edge/workers/sandbox/tool-host.ts` | Present | Centaur bridge lineage and protocol at `edge/workers/sandbox/tool-host.ts:1-21`. |
| `containers/harness/Dockerfile` | Present | Pinned build and Ubuntu 22.04 runtime at `containers/harness/Dockerfile:1-16,43-54`. |
| `containers/harness/SYSTEM_PROMPT.md` | Present | Adapted behavioral prompt exists; section accounting is documented at `implementation-notes.md:91-117`. |

The substantially modified file list in `SPEC.md:455-464` is also represented in the current tree. Note that the spec says `wrangler.toml`; both dev and production configs now carry `SessionEventDO` (`edge/wrangler.toml:24-40`; `edge/wrangler.bot.toml:22-34`).

## GOAL.md house-rule verdicts

| Rule | Verdict | Source-backed assessment |
| --- | --- | --- |
| 1. Events API only | Pass | Slack routes terminate in `edge/src/worker.ts:146-209,211-260,275-329`; manifest disables Socket Mode (`slack-app-manifest.yaml:73-90`). Root Railway/runtime residue is not the bot per `AGENTS.md`, and production deploy points at `wrangler.bot.toml`. |
| 2. DO for all durability | **Partial** | Durable state, session log, choices, and thread memory are DO-backed (`edge/wrangler.bot.toml:10-34`; `edge/src/store/session-event-do.ts:440-551`). `agentsByConversation` is explicitly an isolate cache (`edge/src/slack/cloudflare-slack-adapter.ts:173-195`) and is compensated by transcript injection, so it is not itself a violation. The optional `SESSION_EVENTS` accept-without-durability escape hatch is a real contract weakness (M6). |
| 3. Never post duplicates / exact IDs | **Fail under ambiguous Slack create** | Internal stable IDs and admission dedup are strong (`edge/src/slack/turn-lifecycle.ts:217-228,340-377`; `edge/src/store/session-event-do.ts:205-249`), but ordinary live creates have no stable Slack `client_msg_id` (H1), and `forwardedMessageId` remains optional (M6). |
| 4. 50-block limit with graceful overflow | **Partial** | Current builders cap at 50 (`edge/src/slack/stream-render.ts:13-15,54-68`; `edge/src/slack/quick-card.ts:35-40,104-145`), so invalid 51-block payloads are avoided. Generic stream overflow is truncated, not continued (M2). |
| 5. Rate-limit discipline via conflation | **Fail on main AG-UI path** | The adapter's standalone stream conflates and waits 800 ms (`edge/src/slack/cloudflare-slack-adapter.ts:838-891`), but the actual AG-UI renderer bypasses that layer and independently throttles continuation messages (H3). |
| 6. HITL gates | Pass for the locked high-risk surfaces audited | Remote git is durably per-turn approved and postcondition checked (`DECISIONS.md:195-208`); interactions return 503 rather than falsely acknowledging failed durable choice persistence (`edge/src/worker.ts:306-316`). This audit performed no deploy or external write. |
| 7. Centaur untouched | Pass for this audit; repository already dirty | Current Centaur status is `M AGENTS.md` plus untracked `docs/public/md/capabilities.md`, exactly the pre-existing drift recorded in `implementation-notes.md:204-207`. This audit made no Centaur writes; a dirty tree cannot independently prove older provenance. |
| 8. Typecheck must pass | Pass now | `cd edge && npm run typecheck` exited 0; separate harness typecheck also exited 0 (results below). |
| 9. Existing tests must pass | Pass now | `cd edge && npm test` passed 39 files / 559 tests; workerd e2e passed 1 file / 24 tests (results below). |

## Documentation/operations claim audit

- **Overclaim:** `docs/centaur-port.md:3` says A1-A5 are implemented. Attachment hardening in A4 is not, the automatic artifact card is not, and live harness rendering remains deferred. A more accurate status is “core A1-A5 spine landed; attachment and live-render subfeatures incomplete.”
- **Overclaim:** `docs/centaur-port.md:66` says the minimum delivery counters are implemented, but SPEC's `streamed`, `answer_visible`, and `failed_size_limit` outcomes have no producer (M5).
- **Overclaim:** `ARCHITECTURE.md:421-435` says text is bounded and high-frequency structured chunks traverse conflation. Recovery text is unbounded (C1) and the main AG-UI path bypasses conflation (H3).
- **Weak health semantics:** `docs/operations.md:249-260` labels `/health` as the bot/StateStore health surface, but the route is static and omits `SESSION_EVENTS` (`edge/src/worker.ts:43-53`).
- **Accurate intentional limits:** The port ledger correctly discloses opt-in harness binding, buffered harness Slack output, richer task/plan cards as future work, no event viewer, and GitHub-only outbound policy (`docs/centaur-port.md:272-286`). These are not hidden defects.

## Current validation results

Executed from the current working tree on 2026-07-13; no deployment or external mutation was performed.

| Command | Result |
| --- | --- |
| `cd edge && npm test` | **PASS** — 39 test files, 559 tests; 2.24 s. Node printed only the expected experimental SQLite warnings. |
| `cd edge && npm run test:e2e` | **PASS** — 1 workerd test file, 24 tests; 4.57 s. |
| `cd edge && npm run typecheck` | **PASS** — `tsc --noEmit`, exit 0. |
| `cd edge/workers/sandbox && npm run typecheck` | **PASS** — `tsc --noEmit`, exit 0. |

Green tests do not cover the main gaps above: no test exercises over-limit obligation recovery, ambiguous live `chat.postMessage` replay, late Slack file arrival, attachment delivery into the harness, automatic artifact-card posting, or a per-channel rate limit across multiple continuation messages.

## Recommended repair order

1. Fix C1 and H1 together so all live/recovery creates share bounded payloads and stable external idempotency keys.
2. Put AG-UI rendering behind one per-channel conflation/rate scheduler and make update failure observable to the obligation engine (H3).
3. Complete the attachment contract end-to-end: late correlation, staged tiers, harness transport, and follow-up replay (H2/M1).
4. Enforce required `SESSION_EVENTS`/`forwardedMessageId` contracts and add readiness checks (M5/M6).
5. Wire the existing quick-card and harness `onText` hooks once their product surfaces are enabled (M3/M7).
