# Harness, attachment, session-context, and attribution remediation evidence

Date: 2026-07-14

Scope: C1, H2, H3, H6, M3, and M4 from `goal-outputs/opentag-2-gap-audit/gap-audit.md`. No Worker/Container deployment, live Slack/API call, or external write was performed. The production harness binding remains activation-gated.

## Result

The owned compatibility seam now fails closed instead of silently changing runtimes, carries bounded inline attachments through the real harness request and filesystem boundary, exposes a durable staged-reference tier, reconstructs prior SessionEventDO conversation turns, extracts bounded rich Slack history, provides durable late-file-repair primitives, and strengthens GitHub attribution sourcing and pre-write uniqueness.

## Finding evidence

### C1 — authoritative coding never silently falls back

- `edge/src/agent-turn.ts:468-482` validates whether the Claude harness is reachable and posts a visible terminal rejection when it is not.
- `edge/src/agent-turn.ts:641-658` evaluates repository-coding intent independently of explicit flags. Coding intent selects the authoritative harness; missing reachability or `HARNESS_REPO_URL` visibly rejects before AG-UI.
- `edge/src/agent-turn.ts:1028-1035` turns every selected-harness failure into `AuthoritativeHarnessError`; the previous read-only AG-UI fallthrough is removed.
- `edge/test/agent-turn-harness.test.ts` covers disconnected selection, coding failures, read-only harness failures, interrupts, duplicates, and repository routing.
- Activation remains gated: no service binding was enabled and no deploy command was run.

### H2 — truthful model/provider override behavior

- `edge/src/slack/overrides.ts:89-116` makes `--model` imply `claudecode`, strips and reports unsupported `--codex`, and reports all `-rsn` values as unsupported because no Codex runtime exists.
- `edge/src/agent-turn.ts:564-583` validates those errors and harness reachability before `resolveThreadOverrides`, so rejected selections are not persisted.
- `edge/src/agent-turn.ts:456-466` confirms an override as `Active`, not merely `Saved`, only after validation.
- `edge/test/overrides.test.ts`, `edge/test/thread-overrides.test.ts`, and `edge/test/agent-turn-overrides.test.ts` pin parsing, stickiness, rejection, and no-persistence behavior.

### H3 — bounded tiers, durable representation, late repair, and harness transport

- `edge/src/slack/download-files.ts:16-54` defines serializable inline/staged attachment references, an injectable durable stager, an 8 MiB default inline tier, and a 32 MiB staged tier.
- `edge/src/slack/download-files.ts:101-130` reads Slack downloads as bounded streams and cancels when the declared or observed size exceeds the selected tier.
- `edge/src/slack/download-files.ts:198-256` emits native AG-UI media/text plus non-enumerable OpenTag metadata, avoiding duplicate base64 serialization while preserving the harness envelope.
- `edge/src/harness/client.ts:38-46,388-399` sends attachment envelopes on `/turn`; `edge/workers/sandbox/turn-contract.ts:27-45,150-186` validates count, metadata, base64, staged keys, per-file size, and decoded aggregate size.
- `edge/workers/sandbox/src/router.ts:19-21,181-199` and `edge/workers/sandbox/harness-server.ts:69` enforce a 12 MiB request ceiling, enough for the contract's 8 MiB decoded inline aggregate after base64 expansion.
- `edge/workers/sandbox/harness-server.ts:145-169,1459-1478` materializes exact inline bytes under the disposable per-execution home, outside the repository checkout, and gives Claude absolute paths. Unresolved staged references fail the turn visibly instead of being omitted.
- `edge/src/slack/late-file-repair.ts:1-52` provides stable pending/dedupe keys, a 15-second same-team/channel/user/thread correlation rule, expiry checks, and `files.info` hydration detection.
- `edge/test/download-files.test.ts`, `edge/test/late-file-repair.test.ts`, `edge/test/harness-client.test.ts`, `edge/test/harness-container-router.test.ts`, and `edge/test/harness-server.test.ts` cover the transport and limits.

### H6 — reliable requester attribution and exact pre-write guard

- `slack-app-manifest.yaml:56-59` adds `users.profile:read`.
- `edge/src/slack/web-api.ts:359-378` calls form-encoded `users.profile.get` with `include_labels=true`, merges a named GitHub custom field with `users.info` identity/email/timezone, and degrades visibly in logs on scope/API failure.
- `edge/workers/sandbox/turn-contract.ts:84-90` accepts a requester attribution only when exactly one valid standalone line exists.
- `edge/workers/sandbox/src/egress-policy.ts:241-249` authorizes the GitHub PR POST only when the body has exactly one `Prompted by:` line and it exactly equals the approved scope.
- `edge/test/slack-web-api.test.ts`, `edge/test/harness-server.test.ts`, and `edge/test/harness-egress-policy.test.ts` cover label inclusion, duplicate requester-context rejection, and conflicting PR-body rejection.

### M3 — canonical SessionEventDO reconstruction

- `edge/src/slack/session-history.ts:80-113` reconstructs ordered user and assistant turns, including tool summaries, from canonical replay events while excluding the active execution.
- `edge/src/agent-turn.ts:747-766` replays the thread's SessionEventDO before merging durable fallback memory. The isolate-local agent object is no longer the only source used after a restart.
- `edge/test/session-history.test.ts` pins reconstruction and active-turn exclusion.

### M4 — rich Slack/history attachment restoration primitives

- `edge/src/slack/session-history.ts:6-75` extracts bounded text from plain messages, Block Kit/rich-text nodes, legacy attachments, URLs, and file metadata; it preserves normalized prior attachment references.
- `edge/test/session-history.test.ts` covers a block-only message carrying a prior PDF reference.

## Cross-owner integration requirements

The following hooks intentionally remain for the adapter/worker/store owners because this task prohibited edits to those paths:

1. In `edge/src/slack/cloudflare-slack-adapter.ts`, normalize raw `conversations.replies` rows with `normalizeSlackHistoryMessage` instead of flattening to `text`, and re-download/re-stage `attachments` before constructing a follow-up prompt.
2. In the adapter's current `buildFileContentParts` call, pass an `AttachmentStager` backed by a durable blob namespace. Before `runHarnessTurn`, resolve a staged reference to bounded inline bytes or add an authenticated container-side blob resolver. The current contract deliberately returns `staged_attachment_unresolved` rather than omitting content.
3. In `edge/src/worker.ts`/pre-admission, persist `PendingFilelessMention` under `pendingLateFileKey` for a fileless mention; on delayed file events, hydrate incomplete files with `files.info`, call `matchLateFileEvent`, wait for thread idle, and pre-admit one synthetic file turn keyed by `lateFileRepairDedupeKey`.
4. Include normalized attachment references/tool results in lifecycle `SessionEventDO.execute` input/output payloads. The new replay path consumes rich output/tool events, but the lifecycle currently decides how much richness is appended.
5. Reinstall the Slack app and refresh the production bot secret after the manifest scope change. This is an activation/external operation and was not performed.
6. Enabling the production `HARNESS` service binding and deploying `opentag-agent`/`opentag-bot` still requires explicit user approval. Until then, coding/selected-Claude turns now fail visibly and do not run AG-UI.

## Verification

- `cd edge && npm run typecheck` — passed.
- `cd edge/workers/sandbox && npm run typecheck` — passed.
- Focused 11-file suite for overrides, routing, attachments, session history, late-file repair, harness client/server/egress, and Slack profile resolution — 246 passed, 0 failed.
- Additional router/transport suite — 140 passed, 0 failed.
- `cd edge && npm test` during concurrent remediation — 580 passed, 6 failed. The six failures were in other owners' evolving Stop/session-handoff and stream-overflow paths (`bot-engine-remote-git`, `slack-agent-stop.integration`, `slack-stream`), not in this bundle. Focused owned suites remained green afterward.

## Surprises / constraints

- The shared worktree changed continuously in adapter, worker, lifecycle, store, stream, and documentation files during this pass. Those edits were preserved and not overwritten.
- Local `rg` was unusable because Homebrew PCRE2 could not be loaded, so inspection used `grep`, `find`, and `sed`.
- Large staged attachment code is intentionally fail-closed until its cross-owner durable blob resolver is connected; reporting it as complete or silently flattening it would recreate H3.
