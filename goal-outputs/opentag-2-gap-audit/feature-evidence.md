# OpenTag 2.0 feature-surface gap evidence

Audit scope: the assigned `SPEC.md` section 7 gaps and section 8 files covering runtime/model overrides, session durability, the Claude Code harness, attachments, quick actions, observability, the session link, requester identity, and PR attribution. Verdicts come from production call paths and tests, not from `implementation-notes.md` assertions.

## Executive verdict

The merge contains a real, security-conscious Claude Code image/server and a substantial SessionEventDO, but the production bot is not connected to the harness. Worse, a repository-coding ask with `--claude` is intentionally sent to AG-UI when that binding is absent. This directly violates the architecture's “coding task cannot silently fall back” invariant. Attachment hardening is essentially unimplemented, the documented research quick actions have no product card, observability omits three required delivery counters, and there is no session viewer/link. Slack-to-GitHub identity is wired, but the pre-write PR guard permits an extra `Prompted by:` line and detects the violation only after creating the PR.

## Prioritized findings

### Critical

#### C1. Production has no usable coding harness and silently routes coding intent to AG-UI

**Section 7 gap:** “No real coding harness.”
**Verdict:** Real implementation exists in source, but the production call path is disabled and violates a locked postcondition.

- The production bot config comments out the `HARNESS` service binding (`edge/wrangler.bot.toml:50-58`) and labels harness configuration as future/operator-gated (`edge/wrangler.bot.toml:68-72`). The operations guide also says the bot binding is commented until an operator deploys and connects it (`docs/operations.md:31-34`).
- `runBundledAgentTurn()` selects the harness only when both the sticky harness is `claudecode` **and** `HARNESS`/`HARNESS_URL` exists (`edge/src/agent-turn.ts:527-534`). With no binding, it reaches `thread.runAgent()` on the AG-UI path (`edge/src/agent-turn.ts:940-949`).
- This is not an untested inference: the suite explicitly asserts that `--claude Add a script` calls AG-UI when the harness binding is absent (`edge/test/agent-turn-harness.test.ts:456-463`).
- That behavior contradicts the canonical rule that ordinary non-coding turns may fall back but repository coding turns must fail visibly (`ARCHITECTURE.md:307-311`), invariant 8 (`ARCHITECTURE.md:448-465`), and DECISIONS §15 (`DECISIONS.md:202-208`). It also means SPEC's A5 definition—real code committed and an attributed PR—cannot occur on the shipped production configuration (`SPEC.md:376-386`).
- The implementation itself is not a stub: the digest-pinned Ubuntu image installs Claude Code and developer tools (`containers/harness/Dockerfile:16-54`, `containers/harness/Dockerfile:81-107`, `containers/harness/Dockerfile:160-185`); the server passes `--model` to a headless `stream-json` Claude process (`edge/workers/sandbox/harness-server.ts:321-336`, `edge/workers/sandbox/harness-server.ts:1394-1453`); and the harness client admits/persists the execution through SessionEventDO (`edge/src/harness/client.ts:318-350`, `edge/src/harness/client.ts:413-447`).

**Severity rationale:** the main A5 user outcome is impossible in production, and coding work can be entrusted to a runtime that cannot prove repository postconditions.
**One-line fix:** deploy/connect `opentag-harness`, then reject repository-coding intent before AG-UI whenever the authoritative harness is unavailable (and reverse the test at `agent-turn-harness.test.ts:456`).

### High

#### H1. `--model`, `--codex`, and `-rsn` can be stored/confirmed without changing any runtime

**Section 7 gap:** “No model/harness selection.”
**Verdict:** Partially implemented: alias flags work with a connected Claude harness; several advertised flag forms are nominal only.

- The parser recognizes `--model`, Claude aliases, `--codex`, and `-rsn` and strips them (`edge/src/slack/overrides.ts:26-40`, `edge/src/slack/overrides.ts:56-125`). Sticky model/harness persistence and per-turn reasoning are correctly separated (`edge/src/store/thread-overrides.ts:79-105`). Tests prove alias stickiness and thread isolation (`edge/test/thread-overrides.test.ts:74-108`, `edge/test/thread-overrides.test.ts:130-150`).
- A bare `--model <id>` sets `model` but does **not** infer `harnessType` (`edge/src/slack/overrides.ts:90-95`); harness routing nevertheless requires `effectiveHarnessType === "claudecode"` (`edge/src/agent-turn.ts:532-534`). Thus the headline SPEC example `--model claude-opus-4-8` on a fresh thread is recorded but does not switch the model.
- `--codex` is still accepted (`edge/src/slack/overrides.ts:27-32`) although the port ledger says the Codex/multi-provider harness matrix was intentionally not ported (`docs/centaur-port.md:241-253`). `-rsn` only reaches `effectiveReasoning` (`edge/src/store/thread-overrides.ts:100-105`) and a descriptive AG-UI context (`edge/src/agent-turn.ts:773-800`); `runHarnessTurn` has no reasoning field (`edge/src/harness/client.ts:32-55`) and the only real harness is Claude Code. A flags-only turn nonetheless says “Saved ... applies to this thread” (`edge/src/agent-turn.ts:425-438`).
- When the harness is connected, `--sonnet`/`--opus`/`--haiku` are correctly sticky and the effective model reaches the container (`edge/src/agent-turn.ts:849-861`; `edge/src/harness/client.ts:387-405`; `edge/workers/sandbox/harness-server.ts:321-336`).

**Severity rationale:** users receive a success-like preference confirmation for switches that cannot take effect, and SPEC's explicit `--model` path fails unless a separate harness flag was already set.
**One-line fix:** make `--model` select the sole supported Claude harness, reject unsupported harness/reasoning flags visibly, and only confirm a selection after runtime availability is validated.

#### H2. Attachment hardening is absent: one fixed cap, eager base64, no tiers, no late-file repair

**Section 7 gap:** “Thin attachment handling.”
**Verdict:** Deficient / A4 definition not met.

- SPEC requires size-tier staging plus late-file repair with an idle timeout (`SPEC.md:364-374`) and identifies the gap explicitly (`SPEC.md:423`).
- The implementation has a single 8 MiB per-file cap, five-file cap, and 200 KiB text truncation (`edge/src/slack/download-files.ts:23-33`, `edge/src/slack/download-files.ts:78-93`). It eagerly downloads the whole response into an `ArrayBuffer` (`edge/src/slack/download-files.ts:117-135`) and base64-embeds supported media (`edge/src/slack/download-files.ts:138-159`). There is no R2/blob staging tier and no file-size failure metric.
- Ingress only processes the `files` array present on the initial event (`edge/src/slack/cloudflare-slack-adapter.ts:435-444`). There is no pending-mention correlation, `file_info` hydration, 15-second match window, or idle repair loop anywhere in the production attachment path.
- Tests cover only URL filtering, one tiny image, and prompt merge (`edge/test/download-files.test.ts:11-57`); they do not cover oversize behavior, streamed limits, late arrival, Slack Connect placeholders, or repair/dedup.

**Severity rationale:** large files are dropped rather than staged, and Slack's late file event ordering can cause the agent to execute without the user's attachment. This is a direct A4 done-criteria failure.
**One-line fix:** add metadata/small-inline/large-R2 tiers with bounded streaming reads, then durably correlate and repair late file events before a 15-second idle cutoff.

#### H3. PR attribution uniqueness is enforced only after the PR has already been created

**Section 7 gap:** “No requester→GitHub identity,” plus `Prompted by:` attribution.
**Verdict:** Identity extraction and exact expected attribution are substantially implemented, but the remote-write guard has a precondition hole.

- Slack `users.info` is parsed only from explicitly named `github`/`github_url` profile fields (`edge/src/slack/web-api.ts:86-140`) and puts the handle on the resolved requester (`edge/src/slack/web-api.ts:242-287`). Tests cover URL, `@handle`, plain handle, custom-field label/name, and reject unrelated/status text (`edge/test/slack-web-api.test.ts:55-130`).
- The requester block prefers that verified GitHub handle and emits one expected line (`edge/src/agent-turn.ts:336-365`); it is passed to the harness (`edge/src/agent-turn.ts:849-861`). Pull-request turns are rejected at request validation if no attribution exists (`edge/workers/sandbox/turn-contract.ts:167-170`).
- However, the outbound authorization allows PR creation if the body merely **includes** the expected line (`edge/workers/sandbox/src/egress-policy.ts:230-247`). It does not reject a second `Prompted by:` line. Only the postcondition fetch—after the external POST—requires exactly one line and fails the turn (`edge/workers/sandbox/harness-server.ts:1014-1056`). The current egress-policy test covers omission but not duplicate attribution (`edge/test/harness-egress-policy.test.ts:101-118`).

**Severity rationale:** a malformed or adversarial PR with conflicting attribution can be created remotely; reporting failure afterward does not undo that externally visible integrity error.
**One-line fix:** before authorizing the PR-create POST, require exactly one `Prompted by:` line and require it to equal the approved requester attribution; add a duplicate-line rejection test.

### Medium

#### M1. SessionEventDO is real, but it does not replace isolate-local AG-UI state

**Section 7 gap:** “Isolate-local agent state.”
**Verdict:** Partial: delivery/execution durability is strong; runtime conversation state remains isolate-local and is reconstructed approximately.

- SessionEventDO is registered in production (`edge/wrangler.bot.toml:22-34`) and has append-only events, durable execution/forwarded-message dedup, replay cursors, and exact interrupt tombstones (`edge/src/store/session-event-do.ts:39-64`, `edge/src/store/session-event-do.ts:186-275`, `edge/src/store/session-event-do.ts:289-397`). The harness client persists each NDJSON event before accepting it (`edge/src/harness/client.ts:413-447`). Unit coverage includes cursor replay, forwarded-message dedup, terminal fencing, restart, and interrupts (`edge/test/session-event-do.test.ts:196-237`, `edge/test/session-event-do.test.ts:239-357`, `edge/test/session-event-do.test.ts:360-434`).
- The AG-UI adapter still keeps `agentsByConversation` in an isolate-local `Map` explicitly “so mid-thread turns keep message history” (`edge/src/slack/cloudflare-slack-adapter.ts:169-190`). On isolate loss, `agent-turn.ts` injects a Slack/durable text transcript instead (`edge/src/agent-turn.ts:803-824`); ARCHITECTURE acknowledges this transcript re-feed (`ARCHITECTURE.md:313-315`). SessionEventDO output replay is used for delivery recovery, not to restore the AG-UI agent's internal message/tool state (`ARCHITECTURE.md:223-255`).

**Severity rationale:** user-visible text continuity is mitigated, but internal tool/result state and rich content can disappear across isolates; this is not the section 7 replacement described as “SessionEventDO with replay.”
**One-line fix:** make a durable canonical conversation/event transcript the AG-UI reconstruction source, including tool/result and attachment references, and treat the isolate map only as a cache.

#### M2. Quick-action synthetic ingress is correct, but the promised research/artifact surface is unwired

**Section 7 gap:** “No interactive follow-up cards.”
**Verdict:** Routing core confirmed; product completeness partial.

- `quick_*` clicks derive stable identities, pre-admit durably, resolve the clicking user, bind the normal execution fence, and call the adapter's ordinary ingress sink (`edge/src/slack/quick-actions.ts:134-142`, `edge/src/slack/quick-actions.ts:174-267`). The worker dispatches these actions away from the generic HITL handler (`edge/src/worker.ts:273-328`). Tests assert clicking-user authorship and stable click identity (`edge/test/quick-actions.test.ts:194-252`; `edge/test/quick-actions-identity.test.ts:12-42`).
- The only production card call site is the Linear `IssueList` retry button (`edge/src/components/cards.ts:131-169`; `edge/src/tools/index.ts:406`). `buildQuickDeployCard()` exists (`edge/src/slack/quick-card.ts:61-147`) but has no `edge/src` call site. There is no research-result Retry/Export or Dig-deeper/Export card, despite SPEC's research-card examples and done criterion (`SPEC.md:257-260`, `SPEC.md:364-374`).
- Reliability is also weaker than generic HITL: quick actions are scheduled with `waitUntil` and Slack receives `200` immediately (`edge/src/worker.ts:319-328`), while a failed background turn is only logged (`edge/src/worker.ts:321-323`) and is no longer Slack-retryable.

**Severity rationale:** the mechanism works where called, but the user-facing research/artifact capability advertised by A4 is absent and background handoff can be lost after acknowledgement.
**One-line fix:** add real research Retry/Export buttons (and wire artifact scanning), and synchronously complete durable pre-admission before returning the interaction acknowledgement.

#### M3. Structured lifecycle logs exist, but the minimum delivery-health taxonomy is incomplete

**Section 7 gap:** “No observability.”
**Verdict:** Partial.

- Lifecycle logs emit JSON for `turn_started`, `turn_completed`, and `turn_failed` (`edge/src/slack/turn-lifecycle.ts:318-318`, `edge/src/slack/turn-lifecycle.ts:423-466`). Recovery emits `fallback_sent`/`error_visible` after confirmed Slack delivery (`edge/src/store/conversation-state-do.ts:1091-1110`, `edge/src/store/conversation-state-do.ts:1208-1214`), and Stop emits `stop_command_received` (`edge/src/slack/stop-routing.ts:433`).
- SPEC's minimum also requires `streamed`, `answer_visible`, and `failed_size_limit` (`SPEC.md:300-307`). None is emitted in `edge/src`; `answer_visible` appears only in a comment (`edge/src/agent-turn.ts:881-885`). No Analytics Engine binding or `writeDataPoint` call exists in the bot environment/Wrangler config.
- The missing `failed_size_limit` is especially material because attachments are silently represented only by a user-facing note after the 8 MiB cap (`edge/src/slack/download-files.ts:110-135`).

**Severity rationale:** basic turn/error rates are queryable from logs, but operators cannot compute live-vs-fallback delivery health or size-limit failure rates required by the spec.
**One-line fix:** centralize a typed metric emitter and emit all eight minimum counters at confirmed transitions, optionally mirroring them into a configured Analytics Engine dataset.

### Low

#### L1. No session viewer, endpoint, link, or first-message context block exists

**Section 7 gap:** “No session viewer / console link.”
**Verdict:** Unimplemented and explicitly deferred.

- SPEC asks for a first-assistant-message context block linking a Worker/admin event view (`SPEC.md:69-73`) and lists `edge/src/slack/session-link.ts` in the section 8 file tree (`SPEC.md:431-452`). That file does not exist.
- The current port ledger explicitly says “Console | None” and calls the viewer future work (`docs/centaur-port.md:257-270`, `docs/centaur-port.md:283-284`). No `Open in console`/session link call appears in `edge/src`; only assistant title setup exists (`edge/src/agent-turn.ts:580-610`).

**Severity rationale:** this is a low-effort operator/debug UX gap, not a turn-correctness failure; SPEC itself labels it low effort.
**One-line fix:** expose an authenticated read-only SessionEventDO event endpoint and append a once-per-thread context block with link, effective model, and harness.

## Section 8 file-tree audit

| Planned surface | Source verdict |
|---|---|
| `edge/src/slack/overrides.ts` | Present and production-called; semantic gaps in H1. |
| `edge/src/slack/quick-card.ts` | Present, but artifact-card builder has no production caller. |
| `edge/src/slack/quick-actions.ts` | Present and routed through normal ingress; see M2. |
| `edge/src/slack/session-link.ts` | **Missing.** |
| `edge/src/store/session-event-do.ts` | Present, registered, and well tested; see M1. |
| `edge/workers/sandbox/harness-server.ts` | Present as the real Node container shim; validates/streams/interrupts and verifies git postconditions. |
| `edge/workers/sandbox/tool-host.ts` | Present, but optional and has no configured tool CLI by default. |
| `containers/harness/Dockerfile` / `SYSTEM_PROMPT.md` | Present, pinned, non-root, and copied into the image; image build was not run in this audit. |

## Important Centaur capability differences still material here

- **No multi-harness matrix:** the port ledger intentionally omits Amp/Codex/multi-provider support (`docs/centaur-port.md:241-265`), yet OpenTag still parses `--codex` and `-rsn`, causing H1's misleading surface.
- **No repo snapshot/cache tier:** the harness only reuses `/work/<session>` or performs `git clone --depth=1` (`edge/workers/sandbox/harness-server.ts:805-925`); SPEC's R2 cache/freshness tier is absent, so large repositories retain cold-start cost.
- **No live coding render:** the client accumulates text and exposes an unused `onText` hook (`edge/src/harness/client.ts:53-55`, `edge/src/harness/client.ts:407-434`), while `agent-turn.ts` posts one final result (`edge/src/agent-turn.ts:881-918`). The port ledger acknowledges this (`docs/centaur-port.md:278-280`).
- **No harness Slack-file/upload or broad tool catalog:** the image exposes an optional bridge only when `OPENTAG_TOOL_BIN` is configured (`containers/harness/Dockerfile:208-217`); this is materially narrower than Centaur for attachment-centric coding/document tasks.

## Current verification results (2026-07-13 PDT)

- `cd edge && npm run typecheck`: **pass**.
- `cd edge && npm test`: **pass, 39 files / 559 tests**.
- `cd edge && npm run test:e2e`: **pass, 1 file / 24 tests** (workerd StateStore suite).
- `cd edge/workers/sandbox && npm run typecheck`: **pass**.
- Not run: Docker image build, live Slack interaction, deployed Worker/container smoke test, real Claude invocation, real git clone/push/PR. Therefore passing tests establish source-level behavior only; they do not show that the disabled production harness works operationally.

## Confirmed-correct paths

- Sticky Claude alias behavior, per-thread isolation, and per-turn-only reasoning storage are covered and correctly implemented when the real harness is selected.
- SessionEventDO's exact execute/dedup/replay/interrupt contract and its production registration are substantive, not nominal.
- The container shim is a real Claude Code process wrapper with clone/reuse, non-root execution, bounded request validation, NDJSON persistence, interrupt/process-group cleanup, and mechanical commit/PR postconditions.
- Quick clicks re-enter the ordinary synthetic user-turn path with the clicking Slack identity and durable execution fencing.
- Slack named-profile GitHub extraction and propagation into `[Requester Context]` are correctly wired; the remaining attribution defect is specifically the pre-write uniqueness check in H3.
