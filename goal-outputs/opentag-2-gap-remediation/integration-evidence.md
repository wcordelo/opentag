# OpenTag 2 gap-remediation integration evidence

Date: 2026-07-14. Scope: shared adapter/lifecycle/Worker/store call sites and the four full-unit-suite failures recorded at the integration baseline. No deploy, Slack reinstall/message, GitHub write, commit, or push was performed.

## Integrated production paths

- **C2 live/recovery identity:** `edge/src/slack/client-message-id.ts` derives a stable UUID synchronously from immutable execution identity. `pre-admit-turn.ts` reserves it before the first await and stores it with the active row plus initial obligation. `turn-lifecycle.ts` propagates it for non-provisional obligations. `cloudflare-slack-adapter.ts` uses it on the first visible post, confirms the returned Slack `ts`, and resolves ambiguous/duplicate-without-`ts` outcomes through the bounded exact lookup before marking absence. The shared integration fake now exercises both live-message CAS RPCs.
- **C3/M7 terminal ownership:** the production composition root rejects a production environment without `SESSION_EVENTS`; final adapter writes still terminalize SessionEventDO inside the final render fence.
- **H1 exact Stop:** request-time tests now return the required matching `{accepted:true, quiescent:true, executionId}` proof. Alarm-resumed Stop now performs the same exact AG-UI control request when the session has no harness session, and does not misclassify an exact research-task continuation as AG-UI work.
- **H3/M4 attachment/history:** the adapter composition root supplies `BLOBS`; current and reconstructed files share a content-addressed R2 stager. `getMessages()` uses bounded rich Slack normalization and preserves attachment refs. `agent-turn.ts` excludes the current event, re-downloads/re-stages up to five prior-thread refs, and passes them through the existing AG-UI/harness attachment envelope.
- **H4 scheduler:** the production adapter constructs one shared per-channel scheduler for all renderers in that bot isolate (1,000 ms in production).
- **H7 lossless overflow:** `stream()` updates page zero and posts deterministic, UUID-keyed continuation pages inside the same final fence. The AG-UI final renderer uses the same paging rule and commits final ownership only after every continuation succeeds. The former truncation assertion now reconstructs all 200,000 input characters.
- **M6 health:** `GET /health` calls both real durability probes and returns HTTP 503 on failure instead of static green metadata.

## Four named regression failures

The three missing `Stopped` posts were stale mocks: they returned a generic Slack-shaped success to the new exact AG-UI interrupt endpoint. The mocks now return matching execution identity and quiescence. The fourth test expected the old H7 ellipsis truncation and now asserts lossless continuation reconstruction. No locked Stop or overflow semantic was weakened.

## Verification

- `cd edge && npm run typecheck` — PASS.
- Focused shared integration: `npx vitest run test/render-obligation.test.ts test/slack-agent-stop.integration.test.ts test/bot-engine-remote-git.test.ts test/slack-stream.test.ts` — PASS, 63/63.
- Expanded changed-path integration (eight files covering adapter/history/files/health/store/Stop) — PASS, 90/90 after shared-fake repair.
- `cd edge && npm test` — PASS, 45 files and 591/591 tests.
- `cd edge && npm run test:e2e` — PASS, 24/24 workerd tests.
- `cd edge/workers/sandbox && npm run typecheck` — PASS.
- `git diff --check` — PASS.

## Remaining blockers for the goal owner / fresh review

These are not claimed resolved by this integration pass:

1. `late-file-repair.ts` remains a tested correlation primitive but `worker.ts` does not yet persist pending fileless mentions, hydrate delayed `files.info` rows, wait for exact thread idle, or pre-admit the synthetic repair turn. H3 remains incomplete until that call site and regression test land.
2. Live `streamed` / `answer_visible` Analytics Engine emission is still recovery-only; the adapter composition root does not yet receive `DELIVERY_METRICS`. M6 is only partially complete despite live health now being real.
3. SessionEventDO reconstruction consumes tool summaries and attachment-capable Slack history, but lifecycle input/output events still persist primarily flattened text. M3 rich canonical history remains partial.
4. The shared scheduler covers the production adapter/renderers, while raw auxiliary clients in Stop/title/profile/rejection paths still construct independent clients. H4's literal all-egress centralization remains partial.
5. `SessionEventDO.compact()` has source/tests but no caller-proven safe-cursor scheduling call site. L3 remains partial.
6. Session-link and quick-card decoration are wired on AG-UI final rendering, not every direct/harness final post. L1/M5 parity remains partial.
7. A fresh independent audit review is still required; this file is implementation evidence, not that review.

Production harness binding/deployment and Slack scope reinstall remain explicit external activation steps and were not attempted.

## Focused continuation: previously listed blockers

This continuation supersedes items 1–6 in the preceding blocker list:

1. **Late-file Worker repair is now integrated.** `/slack/events` persists a bounded pending fileless mention, correlates a delayed same-user/channel upload, hydrates incomplete rows through form-encoded `files.info`, waits for the exact thread's durable active row to clear, and pre-admits one synthetic `file_share` continuation under a stable dedupe identity. The pending row is deleted only after framework handoff. Focused tests cover correlation, hydration, bounded idle polling, Web API encoding, and exact downloaded-byte preservation in the agent content part.
2. **Live delivery outcomes now reach Analytics Engine.** The bot composition root passes `DELIVERY_METRICS`; direct, stream, and AG-UI rendering emit `streamed`, `answer_visible`, or `failed_size_limit` only after the corresponding Slack operation is confirmed. Size-limit handling confirms a bounded visible error before recording failure.
3. **Canonical session history is rich and reconstructible.** Lifecycle input events use a versioned JSON envelope for attachment metadata (without duplicating bytes), reconstruction remains backward-compatible with legacy text, and AG-UI tool start/result events append bounded structured tool summaries. Reconstructed attachments continue through the same download/stage path.
4. **Request-time Slack scheduling is shared across auxiliary clients.** Bot renderers, Stop, lifecycle notices, agent title/profile lookup, and quick actions use the per-environment shared scheduler. Operations documentation distinguishes that isolate-local owner from the sequential, durably re-armed Durable Object alarm owner.
5. **L3 has a production safe-cursor caller.** After an obligation is successfully served or affirmatively cleared, the alarm owner invokes `SessionEventDO.compact()` only through that obligation's already-consumed `afterEventId`. Compaction failure is logged and cannot retry or duplicate a confirmed Slack render. The alarm regression asserts the exact thread and cursor passed to compaction; lower-level compaction tests retain recent replay/dedup state.
6. **Direct/harness and AG-UI final decoration share parity.** Final direct posts and AG-UI updates use the same once-per-thread session context and bounded Quick artifact card rules, persist markers only after confirmed visibility, and never evict answer blocks to fit decoration.
7. **Operations claims are corrected.** The documented metrics are emitted source metrics, coding/harness unavailability is explicitly fail-visible with no silent AG-UI reinterpretation, and request-time versus alarm-owned Slack rate discipline is stated separately.

## Continuation verification

- `cd edge && npm run typecheck` — PASS after Worker, session-history, metrics, scheduler, and compaction integration.
- `npx vitest run test/late-file-repair.test.ts test/download-files.test.ts test/slack-web-api.test.ts test/render-obligation.test.ts test/session-history.test.ts` — PASS, 5 files and 56/56 tests.
- `cd edge/workers/sandbox && npm run typecheck` — PASS.
- `git diff --check` — PASS.

The goal owner is running the final full unit/e2e cascade and fresh independent audit. External harness activation/deploy, Slack scope reinstall, remote git, and real-channel writes remain approval-gated and were not attempted.

## Report-author corrective pass

The report audit's two BLOCKING source findings are corrected at their production call sites:

- **H3 staged attachments:** `opentag-harness` now declares the same `BLOBS` R2 binding used by the bot stager. After bearer authentication and initial contract validation, the harness frontend resolves staged objects, enforces the 32 MiB decoded aggregate bound, verifies declared size and optional SHA-256, converts them to the bounded inline container envelope, revalidates, and only then installs approval/starts the container. A missing binding/object or integrity mismatch fails before container admission; `harness-server.ts` continues to reject any unresolved staged ref. The integrated regression begins with an 8 MiB + 1 byte Slack download, stages it through the real R2 stager, traverses `runHarnessTurn` and `routeHarnessRequest`, invokes the real attachment materializer, and compares every harness-visible byte.
- **M5 research cards:** `OrchestratorDO.drainDeliveries()` now passes final task identity through `deliverResearchSlackObligation()` to the actual Slack delivery helper. Final research posts contain the synthesis plus stable `quick_retry`, `quick_dig_deeper`, and `quick_export` buttons. Their `{type:"research",taskId}` refs are decoded by the existing interaction route; stable Slack click identity acquires exact durable pre-admission before the ordinary synthetic-turn handoff. Artifact Re-generate/View files/Delete behavior is unchanged.
- **L2 documentation:** `docs/centaur-port.md` and `docs/operations.md` now describe the implemented R2 resolver and bounds, research cards and ingress, confirmed delivery metrics, and fail-visible harness behavior. They explicitly retain harness deployment/binding as an operator activation step.

Corrective verification:

- `cd edge && npm run typecheck` — PASS.
- `cd edge && npx vitest run test/harness-container-router.test.ts test/quick-actions.test.ts test/research-final-delivery.test.ts` — PASS, 3 files and 52/52 tests, including exact-byte staged resolution and missing-binding fail-closed admission.
- `pnpm vitest run lib/research/__tests__/delivery.test.ts` — PASS, 6/6 tests.
- `cd edge/workers/sandbox && npm run typecheck` — PASS.
- `git diff --check` — PASS.
- `python3 goal-outputs/opentag-2-gap-remediation/validate.py` passes all source-evidence anchors, then stops only because the separately owned `remediation-report.md` has not yet been written.

No Worker/Container deployment, Slack reinstall/message, GitHub write, commit, push, or other live external mutation was performed.
