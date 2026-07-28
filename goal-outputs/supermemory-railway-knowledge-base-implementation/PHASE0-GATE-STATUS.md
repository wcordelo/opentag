# Phase 0 gate status — Cerebras-style OpenTag KB mutations

**Date:** 2026-07-28
**Branch:** `agent/supermemory-railway-kb`
**Mode:** file-only source + tests. No Railway mutation, no Worker deploy, no secret set.

## Verdict

Phase 0 code for Local update/delete is landed behind an exact env gate. Default runtime remains fail-closed (`unsupported_update_contract` / `unsupported_delete_contract`). SDK request shapes for `documents.update` (PATCH) and `documents.delete` (DELETE) are contract-tested against `supermemory@4.24.12`. **Local `server-v0.0.5` live mutation behavior is still unproven** and must stay OFF until R1 smoke + a separate mutation enablement approval.

## Gate board

| Gate | Status | Evidence / next action |
| --- | --- | --- |
| B0–B4 Slack KB (add/poll/search/tombstone fail-closed) | **DONE** (prior) | Existing ledger/adapter/reconcile suite. |
| Phase 0 mutation adapter + ledger `update` decision | **DONE** (this change) | `updateSlackDocument` / `deleteSlackDocument`; `prepareRevision(..., { mutationsVerified })`. |
| `SUPERMEMORY_MUTATION_CONTRACT` default OFF | **DONE** | Only exact string `verified` enables mutations (`local-mutation-contract.ts`). |
| SDK mutation shapes | **VERIFIED** | `edge/test/supermemory-contract.test.ts` asserts PATCH + DELETE `/v3/documents/{id}`. |
| Local live update/delete | **UNPROVEN** | Blocked on R1 binary smoke. Do not set `verified` in any env. |
| Task G fresh adversarial re-review | **OPEN** | Still required before R1 planning is review-complete. |
| R1-P1 Railway create/link/configure/deploy | **AWAITING APPROVAL** | See `R1-DEPLOYMENT-PLAN.md`. Plan staged; **not executed**. |
| Worker `SUPERMEMORY_URL` / API key / mutation flag | **AWAITING LATER GATE** | Not part of Phase 0 or R1-P1. |

## What Phase 0 changed

- Optional `Env.SUPERMEMORY_MUTATION_CONTRACT`.
- Ledger can return `{ decision: "update", localDocumentId }` when `mutationsVerified` is true; otherwise keeps blocked unsupported update.
- Queue dispatch:
  - Unverified delete/disable → tombstone `unsupported_delete_contract` (unchanged default).
  - Verified delete/disable → Local delete when ledger has `localDocumentId`, then tombstone `deleted`.
  - Verified prepareRevision update → `updateSlackDocument` then same poll/`localAccepted` path as add.
- Tombstone outcome allows `errorCode?: "unsupported_delete_contract" | "deleted"`.

## Explicit non-actions

- Did not deploy Workers/Containers.
- Did not create/link/configure any Railway resource.
- Did not set Cursor/Railway/Cloudflare secrets.
- Did not set `SUPERMEMORY_MUTATION_CONTRACT=verified` anywhere.
- Did not enable tracked knowledge sources or Queue production wiring.

## Exit criteria for closing Phase 0 → R1

1. Task G reports zero BLOCKING findings (or corrections + fresh zero-blocker review).
2. Operator issues explicit R1-P1 approval using the language in `R1-DEPLOYMENT-PLAN.md`.
3. After Local smoke proves PATCH/DELETE, a **separate** approval may set `SUPERMEMORY_MUTATION_CONTRACT=verified` on the bot Worker only.
