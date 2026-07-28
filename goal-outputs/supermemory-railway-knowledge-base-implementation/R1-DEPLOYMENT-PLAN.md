# R1 deployment plan — Supermemory Local on Railway

**Status:** staged proposal only. **Not executed.**
**Date:** 2026-07-28
**Stop gate:** R1-P1 — no Railway create/link/configure/deploy, no secret injection, no Cloudflare Worker binding mutation, and no `SUPERMEMORY_MUTATION_CONTRACT=verified` until explicit written approval naming the exact targets below.

This plan is the file-only Phase 0 staging artifact required before any external Railway work. It does not authorize mutation. Approving this document alone is insufficient; a separate explicit R1 execution approval must list exact IDs and commands.

## Preconditions that remain open

| Gate | Status | Why it blocks R1 execution |
| --- | --- | --- |
| Task G fresh adversarial re-review | **OPEN** | Zero-blocker independent review is still owed before R1 planning is considered review-complete. |
| Architecture permission for Railway knowledge state | **AWAITING APPROVAL** | Must reconcile Railway sidecar with OpenTag Cloudflare-only product-state invariants. |
| Local `server-v0.0.5` live smoke | **UNPROVEN** | Bind host, health endpoint, first-boot key path/format, volume ownership, and update/delete live semantics are not proven against the pinned binary. |
| Mutation contract | **SDK shapes verified; Local live OFF** | Code accepts `SUPERMEMORY_MUTATION_CONTRACT=verified` but default remains fail-closed `unsupported_*`. Do not set `verified` until R1 smoke proves Local PATCH/DELETE. |

## Exact proposed targets (not created)

| Resource | Exact proposed value | Notes |
| --- | --- | --- |
| Workspace | `William Lopez-Cordero's Projects` (`546abf5f-9447-4d89-84d3-5e5e08c809a0`) | From read-only Railway readiness audit. Reconfirm with `whoami` before any mutate. |
| New project name | `opentag-supermemory-local` | **New project only.** Do not reuse `opentag-hybrid`, `signalsci`, `consulting`, or `senpi-openclaw`. |
| Environment | `production` | Created only with the new project. |
| Service name | `supermemory-local` | Dedicated Local binary service. |
| Volume name / mount | `supermemory-data` → `/var/lib/supermemory` | Matches `SUPERMEMORY_DATA_DIR` in `infra/supermemory/`. |
| Public domain | Railway-generated HTTPS service domain only for first smoke | No custom DNS until a later approved gate. |
| Build context | `infra/supermemory/` | Dockerfile pins `server-v0.0.5` + published SHA-256. |
| Binary pin | `server-v0.0.5` | x64 `b2fccca3…edaf375`; arm64 `dd3e48fb…40613c0f`. |

No project ID, service ID, environment ID, volume ID, or domain ID exists yet for these targets. Any execution approval must re-list the IDs Railway returns after create and pause again before configure/deploy.

## Non-secret runtime variables (proposed)

Set only after create/link approval and only on the new service:

- `PORT` — Railway-injected; entrypoint must pass through unchanged.
- `SUPERMEMORY_DATA_DIR=/var/lib/supermemory`
- `OPENAI_MODEL=gpt-5.1`
- `OPENAI_FAST_MODEL=gpt-5.1`
- `OPENAI_TEXT_MODEL=gpt-5.1`
- `SUPERMEMORY_EMBEDDING_PROVIDER=local`
- `SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5`
- `SUPERMEMORY_EMBEDDING_DIMENSIONS=768`

Do **not** set `DATABASE_URL`. Do **not** invent `healthcheckPath` until the pinned binary proves an unauthenticated non-content HTTP 200 endpoint.

## Secrets (ownership only; values not set here)

| Secret | Owner | Injection rule |
| --- | --- | --- |
| `OPENAI_API_KEY` | Operator / Cursor Secrets | Injected into Railway service variables only after R1 approval; never committed. |
| Local bearer `sm_...` | Generated on first boot into the volume | Captured via approved redacting entrypoint / operator path; never printed into CI logs or this repo. |
| Cloudflare `SUPERMEMORY_URL` / `SUPERMEMORY_API_KEY` | Separate C1 Worker config gate | **Not part of R1.** Worker secrets stay unset until Local smoke passes and a later Worker deploy gate is approved. |
| `SUPERMEMORY_MUTATION_CONTRACT` | Separate post-smoke gate | Remains unset/`off` until Local update/delete smoke is proven. Exact string `verified` only. |

## Ordered execution steps (DO NOT RUN without R1 approval)

Each step is a stop gate. Completing one step does not authorize the next.

1. **R1-P1 approval** — User explicitly authorizes creating the named new Railway project/environment/service/volume only.
2. Create project `opentag-supermemory-local` + `production` environment. Record returned IDs. **Stop.**
3. Create service `supermemory-local` from `infra/supermemory/` build context. Record service ID. **Stop.**
4. Attach volume `supermemory-data` at `/var/lib/supermemory`. Prove mount ownership works with non-root image (or approve an explicit UID fix). **Stop.**
5. Set non-secret variables listed above. Inject `OPENAI_API_KEY` through Railway secrets UI/CLI with approval. **Stop.**
6. First deploy. Capture redacted first-boot evidence that no `sm_...` / provider secret reached Railway logs. **Stop.**
7. Prove bind/listen, document add→poll→`done`, hybrid search under exact `workspace:{teamId}`, persistence across restart, and rollback to previous image digest. **Stop.**
8. Only after step 7: prove Local `PATCH /v3/documents/{id}` and `DELETE /v3/documents/{id}` against the live binary. Then a **separate** approval may set Worker `SUPERMEMORY_MUTATION_CONTRACT=verified`.

## Explicitly out of scope for R1

- Cloudflare Worker/Container deploy (`opentag-bot`, agent, harness).
- Enabling any `tracked_knowledge_sources` row or Queue producer/consumer.
- Slack scope/app changes, canary ingestion, backfill, DLQ replay.
- Setting `SUPERMEMORY_MUTATION_CONTRACT=verified` before Local live mutation smoke.
- Cleanup/deletion of any existing Railway project/service/volume.
- Linking this git checkout to Railway as a shortcut into an existing project.

## Rollback

Until step 6 succeeds, rollback is delete-or-stop the new unused resources only after a separate deletion approval naming exact IDs. After first deploy with a volume, rollback is redeploy previous image digest and retain the volume; wiping the volume destroys corpus and backups and requires its own approval.

## Cost / downtime

- Expected first-period cost: Local binary + volume on a dedicated service; treat as new spend under an approved cap stated in the R1 execution approval.
- Downtime: none to production OpenTag Slack bot — R1 creates an isolated sidecar with no Worker binding until a later gate.

## Approval language required before any mutate

> I approve R1 execution for creating Railway project `opentag-supermemory-local`, environment `production`, service `supermemory-local`, and volume `supermemory-data` mounted at `/var/lib/supermemory`, using build context `infra/supermemory/` pinned to `server-v0.0.5`. This approval does not authorize Cloudflare deploys, source enablement, Queue activation, mutation-contract enablement, or deletion of existing resources.

Until that exact approval exists, **stop. Do not run Railway mutate commands.**
