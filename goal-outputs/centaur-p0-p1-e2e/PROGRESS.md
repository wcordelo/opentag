# Centaur P0/P1 E2E Progress

## Preflight (Slice 0)
- OpenTag baseline: `1574f81dcb29e71d7cbd1177f81744e2d70fff90` = origin/main
- Branch: `cursor/centaur-p0-p1-e2e-166d`
- Daily ledger: only 2026-07-25 present for ≥2026-07-25; **2026-07-26..28 missing** (Centaur checkout unavailable in Cloud env). Proceeded with approved P0/P1 scope from 2026-07-27 Notion E2E spec.
- Drive / tracing: blocked / evaluate-only — out of scope.
- Deploy: not authorized.

## Slice status
- Slice 0: complete
- Slice 1 (redaction): complete — `edge/src/harness/redaction.ts` + client wiring; expanded exact-secret collection
- Slice 2 (images): complete — `image-normalization.ts`, sharp direct deps, Dockerfile packaging; staged→inline preserves `sha256`; **Container smoke blocked (Docker unavailable)**
- Slice 3 (aliases + context): complete — shared `model-aliases.ts`, opus-5 shortcuts, context events + Slack evidence line; SessionEventDO context singleton + evidence upgrade; provider_reported from system init
- Slice 4 (config authority): complete — channelContext / systemPromptOverlay split; legacy `/putConfig` rejects policies/bundle/overlay
- Slice 5 (prompt overlay): complete — contract v2 + turn-contract digest verify + Container composition
- Slice 6 (progress): complete — honest tool lifecycle (started on tool_use, completed on tool_result); live progress message (`harness-progress-live.ts`) separate from final answer; recovery rebuilds context without progress-in-answer
- Slice 7 (hardening): complete — Container `output-redaction.ts` defense-in-depth; adversarial unit/e2e coverage; CI-equivalent validation; draft PR #13; deploy unapproved

## Gap closure (post Slice 7 adversarial)
- [x] Live progress under render fence; final answer without progress markdown
- [x] Recovery `reconstructRecoveryContent` (context + answer; progress excluded from body)
- [x] Honest tool lifecycle + provider_reported model evidence
- [x] Overlay digest in turn-contract; staged sha256 preserved
- [x] SessionEventDO context singleton; putConfig hardened
- [x] Adversarial tests (progress live, recovery, overlay digest, sha256, config, redaction)
- [x] Container redaction defense-in-depth + docs/rollback notes

## Validation
- `cd edge && npm run typecheck` — pass
- `cd edge && npm test` — **737** passed
- `cd edge && npm run test:e2e` — **26** passed
- `cd edge/workers/sandbox && npm run typecheck` — pass
- Container Docker build/smoke — **blocked** (no Docker in Cloud env)
- Deploy — not authorized

## Adversarial review notes
- Secrets: redacted before appendEvent; Container also redacts NDJSON; malformed NDJSON logs digest only
- Prompt authority: Slack `/config` cannot set overlay/policies; legacy putConfig rejects elevation
- Progress: one live message; never in final `thread.post` or obligation recovery body
- Tool completion: only from `tool_result`; no invented success from `tool_use`
- Model evidence: upgrade path to `provider_reported` from provider init
- Image path: exclusive create under execution home; digest before transform; sha256 survives staged resolve
- Remaining blocker: native sharp runtime packaging unproven without Container build
