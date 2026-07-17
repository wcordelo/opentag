# Research delivery overflow correction evidence

Date: 2026-07-15

Scope: Tier 2 BLOCKING finding H7 in the root research delivery path. No Worker or Container deployment, Slack API call, GitHub write, commit, push, or other external mutation was performed.

## Resolution

- `lib/research/delivery/slack.ts` now builds lossless Slack-safe pages instead of slicing final research text at 3,900 characters.
- Each page uses fallback text of at most 35,000 characters and section blocks of at most 3,000 characters, with no more than 50 blocks per message.
- Continuation pages are posted in order with deterministic UUID-shaped `client_msg_id` values derived from the delivery obligation, page protocol version, and page number.
- A replay restarts at page one with the same page identities. Slack duplicate responses are accepted, so already-applied pages are not duplicated and the ambiguous page can be retried without losing the remaining obligation.
- Retry, Dig deeper, and Export actions appear only on the final page, after all result text.
- `edge/workers/orchestrator/src/OrchestratorDO.ts` and `worker/research-alarm.ts` pass the full research delivery payload into this paging path.

## Regression coverage

- `lib/research/__tests__/delivery.test.ts` now sends a 200,000-character final result through `postToSlackThread`.
- The test reconstructs the exact original text from every emitted page, checks fallback and block limits, verifies unique stable per-page identities, confirms action buttons exist only on the final page, and replays the obligation through Slack duplicate responses to prove the page identities remain identical.
- Existing definitive and ambiguous failure expectations were updated to retain page-number context without changing the delivery outcome classification.

## Validation

- `pnpm check-types` — PASS.
- `pnpm test` — PASS, 9 files and 34 tests.
- `git diff --check` — PASS.

The six separate Tier 2 blockers C2, H3, H4, H8, M3, and L2 remain queued for a fresh shared-edge corrective pass.
