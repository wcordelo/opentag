# Centaur P0/P1 E2E Progress

## Preflight (Slice 0)
- OpenTag baseline: `1574f81dcb29e71d7cbd1177f81744e2d70fff90` = origin/main
- Branch: `cursor/centaur-p0-p1-e2e-166d`
- Daily ledger: only 2026-07-25 present for ≥2026-07-25; **2026-07-26..28 missing** (Centaur checkout unavailable in Cloud env). Proceeded with approved P0/P1 scope from 2026-07-27 Notion E2E spec.
- Drive / tracing: blocked / evaluate-only — out of scope.
- Deploy: not authorized.

## Slice status
- Slice 0: complete
- Slice 1 (redaction): complete — `edge/src/harness/redaction.ts` + client wiring; 727 unit tests green
- Slice 2 (images): complete — `image-normalization.ts`, sharp direct deps, Dockerfile packaging; **Container smoke blocked (Docker unavailable)**
- Slice 3 (aliases + context): complete — shared `model-aliases.ts`, opus-5 shortcuts, context events + Slack line
- Slice 4 (config authority): complete — channelContext / systemPromptOverlay split mutations
- Slice 5 (prompt overlay): complete — contract v2 + Container composition
- Slice 6 (progress): complete — provider mapping, SessionEventDO dedup, harness-progress renderer
- Slice 7 (hardening): in progress

## Validation
- `cd edge && npm run typecheck` — pass
- `cd edge && npm test` — 727 passed
- `cd edge && npm run test:e2e` — 25 passed
- `cd edge/workers/sandbox && npm run typecheck` — pass
- Container Docker build/smoke — **blocked** (no Docker in Cloud env)
- Deploy — not authorized

## Adversarial review notes
- Secrets: redacted before appendEvent; malformed NDJSON logs digest only
- Prompt authority: Slack `/config` cannot set overlay; legacy system_prompt → channel_context only
- Progress: not concatenated into reconstructMarkdown final text
- Image path: exclusive create under execution home; digest before transform
- Remaining blocker: native sharp runtime packaging unproven without Container build
