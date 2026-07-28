# Railway readiness — Supermemory Local knowledge base

**Audit date:** 2026-07-18 (America/Los_Angeles)
**Mode:** read-only planning audit. No Railway resource, configuration, deployment, linkage, secret, backup, or deletion operation was performed.

## Decision

Railway access is authenticated and sufficient for read-only discovery, but this OpenTag checkout is **not linked** to Railway and no write permission has been proven. Do not deploy, create, link, modify, restart, redeploy, scale, or delete during this planning phase.

For a future Supermemory Local deployment, create a **new, explicitly approved Railway project** (recommended name: `opentag-supermemory-local`) rather than repurposing `opentag-hybrid` or any other discovered project. Target a new `production` environment and a dedicated service, with the persistent-data design selected before provisioning. This is a recommendation only; no project, service, environment, domain, volume, variable, or token has been created.

Reasoning: `opentag-hybrid` contains four unrelated, sleeping services with active Railway domains and is not linked to this checkout. Reuse would risk ownership and dependency conflicts. Railway documents that service files are ephemeral unless a volume is attached, while volumes are persistent and require a backup/restore plan before destructive work. [Railway Services](https://docs.railway.com/services), [Railway Volumes](https://docs.railway.com/volumes/reference)

## Verified access and method

| Item | Evidence | Result |
| --- | --- | --- |
| CLI | `bunx @railway/cli --version` | `railway 5.27.0` (current CLI package invoked exactly as required) |
| Authentication | `railway whoami --json` | Authenticated as the account whose display name is `William Lopez-Cordero`; no token value was read, printed, or retained. |
| Workspace | `railway whoami --json`, `project list --json` | `William Lopez-Cordero's Projects` — `546abf5f-9447-4d89-84d3-5e5e08c809a0` |
| Checkout linkage | no `.railway` directory or tracked Railway metadata; `railway status --json` | **Not linked** (`No linked project found`). No `railway link` was run. |
| Read operations proven | `whoami`, `project list`, explicit `status`, `service list`, `domain list`, `volume list`, `usage projects`, and `metrics --all` | Identity, projects, environments, services, current deployment cards, domains, volumes, workspace/project usage, and partial service metrics can be read with explicit IDs—without linking the repo. |
| Writes not proven | no mutating command was attempted | Create/link/configure variables or domains; deploy/redeploy/restart/scale; create/restore/delete backups; detach/delete volumes; delete services/environments/projects; and any role/permission administration remain **unproven**. CLI command availability is not authorization evidence. |

The CLI documentation supports explicit `--project`/`--environment` targeting without linking for deployment-related flows; that capability must not be used until an approved execution work package exists. [Deploying with the CLI](https://docs.railway.com/cli/deploying)

## Current visible resource inventory

The following is an observed snapshot, not a claim that every service is healthy. `SLEEPING` and `deploymentStopped: true` are Railway state returned by the CLI; they are not evidence that a resource is unused. The CLI returned some raw timestamps on 2026-07-19 UTC; they are retained as received rather than reinterpreted.

The snapshot contains four live projects, 15 services, 10 active public domains, and three volumes. The public-domain count was rechecked across all 15 service IDs after the initial audit; 10—not 11—were returned.

### Projects and environments

| Project | Project ID | Environment | Environment ID | Access | Current-period usage |
| --- | --- | --- | --- | --- | --- |
| `opentag-hybrid` | `8cc26395-b4e0-45b9-b325-2ac585a264d8` | `production` | `56ef0dde-9068-4b77-8157-2307614241c5` | `canAccess: true` | $0.023218 (1.0%) |
| `signalsci` | `2497d056-7a67-42b7-acbc-eac3c787b659` | `production` | `9a7ca45c-af1a-4b40-89c1-4e6f8179892c` | `canAccess: true` | $2.365424 (98.6%) |
| `consulting` | `b48ccba6-310d-4df4-ae47-90f2060733aa` | `production` | `e4cb25f3-e134-448b-a60d-23b2a86b15a4` | `canAccess: true` | $0.000185 (reported share 0.0%) |
| `senpi-openclaw` | `95dcf765-d0e7-490a-aad5-9cbe1c5ebdcd` | `production` | `e9684dec-0af6-484a-84c3-4f29da98395e` | `canAccess: true` | $0.010492 (0.4%) |

`usage projects --json` also returned a distinct, already-deleted historical `signalsci` project (`067a6d24-601d-4051-8000-1e9e3a010f3e`, deleted 2026-06-27). It is not a live cleanup target.

### Services, latest deployment state, public domains, and volumes

| Project / service | Service ID | Latest deployment ID / state / created | Public domain(s) | Attached volume evidence |
| --- | --- | --- | --- | --- |
| `opentag-hybrid` / `eve-edge` | `27f2ecf3-ed59-481d-82f0-38fba005b1ee` | `48d7326a-456f-448f-a15d-40f6c1c25c1e` / SLEEPING, stopped / 2026-07-07 | `eve-edge-production-1982.up.railway.app` (`5fb2edd5-02fa-4efd-b524-50b5814abaf3`, service, ACTIVE) | none |
| `opentag-hybrid` / `orchestrator` | `5e54aece-a540-4fa2-8ebb-b86c6bbd0c2c` | `3bc1a13d-5877-4d6c-9f3e-354bd40f588b` / SLEEPING, stopped / 2026-07-07 | `orchestrator-production-c892.up.railway.app` (`92180a18-edbf-496c-8274-4833e06be149`, service, ACTIVE) | none |
| `opentag-hybrid` / `eve-runner` | `5f8b0ab7-b702-43d0-b569-20894f6f3f62` | `3606a363-fc19-4d03-b27a-a829a45d7717` / SLEEPING, stopped / 2026-07-07 | `eve-runner-production-d791.up.railway.app` (`385013df-fab6-494a-952b-782c027d9f75`, service, ACTIVE) | none |
| `opentag-hybrid` / `litellm` | `8d3394b8-2853-4fa5-a646-52a8ac82a8f0` | `459fac35-e67f-4a9f-a6ed-55a3203150e0` / SLEEPING, stopped / 2026-07-07 | `litellm-production-cafc.up.railway.app` (`2a2194a9-d1d2-43ac-8435-97080651471e`, service, ACTIVE) | none |
| `signalsci` / `API` | `322bea6b-4edd-4f64-bc10-44ddae062c55` | `ec0ce6e0-4680-4d8f-ab89-910950979499` / SLEEPING, stopped / 2026-07-19 | `api-production-6a3c.up.railway.app` (`682ebe9c-074f-4861-a49f-c6af6ca86fda`, service, ACTIVE) | none |
| `signalsci` / `Litellm` | `6581f310-b70a-4f2b-ae67-56315507a6be` | `343f2a0f-1fbc-4027-a6d4-bf48f359ecf5` / SLEEPING, stopped / 2026-07-17 | none returned | none |
| `signalsci` / `Migrate` | `405a2f88-262d-4d3e-a56c-69ba95ef31f3` | `8abcd1a2-0606-4284-a612-2247a00f322e` / SUCCESS, stopped / 2026-07-19 | none returned | none |
| `signalsci` / `n8n` | `31e448fe-ec88-4c33-8ddf-67b26f276d95` | `7128f099-3e90-4399-9688-a373e492da79` / SLEEPING, stopped / 2026-07-17 | `n8n-production-e2e05.up.railway.app` (`0e64bc7d-c93c-4044-97ea-ca48813fb186`, service, ACTIVE; port 8080) | `n8n-volume` `c05078da-b061-4706-b9e3-d82b7e34eb39`; READY, 155.894/5000 MB, `/home/node/.n8n` |
| `signalsci` / `Postgres` | `535ea1f9-a706-4a30-a14c-54aebe97319b` | `c68f21d5-1457-4773-b824-d6022e060141` / SUCCESS, **not stopped** / 2026-06-27 | none returned | `postgres-volume` `842e1b86-d998-445c-bfd8-2c2a8b473285`; READY, 732.602/5000 MB, `/var/lib/postgresql/data` |
| `signalsci` / `Presidio` | `ab49fc2b-246b-4d3f-9835-6fc6cda5ec95` | `4dfbd957-60c6-4389-b28c-4680534fba43` / SLEEPING, stopped / 2026-07-17 | none returned | none |
| `signalsci` / `Web` | `9a3812a5-96de-4be5-a439-754755f31262` | `f46764b9-1590-4b46-91d3-85b2cd742170` / SLEEPING, stopped / 2026-07-19 | `web-production-32f73.up.railway.app` (`5b21c7fe-ccbd-4cb5-a75e-15daa83aa4f7`, service, ACTIVE) | none |
| `signalsci` / `Worker` | `4a8d25f0-0721-4f33-a6a4-232500cdc7a0` | `285c7c79-8135-493c-80e1-a95746cb3174` / SUCCESS, **not stopped** / 2026-07-17 | none returned | none |
| `consulting` / `audit` | `345f4dff-52be-468a-b239-71b6961cdb2f` | `f55598c3-44ca-490a-bdbb-9e3052bb831a` / SLEEPING, stopped / 2026-05-20 | `berendo-audit.up.railway.app` (`15ac1c2a-6002-401a-b9fa-5a1749d30d33`, service, ACTIVE) | none |
| `consulting` / `Roadhand` | `d8434614-8251-4705-bc68-224f8a95ba25` | `5d562b93-c37e-473e-9538-0f1e000b3362` / SLEEPING, stopped / 2026-05-10 | `roadhand.up.railway.app` (`180b711c-3d53-48fb-b421-d64a99385fd9`, service, ACTIVE) | none |
| `consulting` / `RivetRoute` | `f0f8eb86-84a7-4b87-8858-a38245fe2bb0` | `ab09e119-41a9-40a4-9b65-174ef31d2ec6` / SLEEPING, stopped / 2026-04-29 | `rivetroute.up.railway.app` (`61354e21-0502-40a9-b45e-3517947e10a9`, service, ACTIVE) | none |

`senpi-openclaw` has no services and one detached, READY volume: `senpi-hyperclaw-railway-template-volume` (`70f5cb39-7923-490e-85aa-b00c7b64c1f1`), 71.844/500 MB at `/data`, `serviceId: null`, `isPendingDeletion: false`.

Read-only metrics for the seven-day window returned current CPU/memory/network evidence for active `signalsci` services, including `Postgres` (186.0 MB) and `n8n` (625.5 MB), plus nonzero network measurements for API/Web/n8n/Litellm/Presidio. This supports retaining all `signalsci` resources. The same metrics query returned only names/IDs for `opentag-hybrid`; no workload metric values were available. No application HTTP probe or log inspection was performed, so end-to-end health remains unproven. Railway states that `status` exposes deployment status, replicas, volumes, and regions; deployment state alone is not a health guarantee. [railway status](https://docs.railway.com/cli/status), [railway deployment](https://docs.railway.com/cli/deployment)

## Cleanup assessment — separate future work package

**Default is RETAIN.** These are potential review targets only, not authorization to change anything. Names, age, zero/low current usage, or a sleeping deployment are insufficient evidence of deprecation.

| Candidate (exact ID) | Classification | Evidence checked now | Evidence still required before any change | Backup / rollback | Owner confirmation and approval |
| --- | --- | --- | --- | --- | --- |
| `opentag-hybrid` services: `eve-edge` `27f2ecf3-ed59-481d-82f0-38fba005b1ee`; `orchestrator` `5e54aece-a540-4fa2-8ebb-b86c6bbd0c2c`; `eve-runner` `5f8b0ab7-b702-43d0-b569-20894f6f3f62`; `litellm` `8d3394b8-2853-4fa5-a646-52a8ac82a8f0` | **RETAIN** | Latest deployments all 2026-07-07, SLEEPING/stopped; one active Railway domain per service; no volumes; CLI metrics did not return workload values. | Owner and repository mapping; deployment history/log review; external callers, DNS and webhook/credential dependency check; current traffic/health; confirmation no environment variables or private-network consumers depend on them. | No data volume visible, but deletion loses service/deployment configuration and active domains. Export/configuration capture and a tested re-provision path are required. | Named owner must confirm retirement and exact four IDs; explicit written deletion approval after evidence review. |
| `consulting` services: `audit` `345f4dff-52be-468a-b239-71b6961cdb2f`; `Roadhand` `d8434614-8251-4705-bc68-224f8a95ba25`; `RivetRoute` `f0f8eb86-84a7-4b87-8858-a38245fe2bb0` | **RETAIN** | Older latest deployments (2026-05-20, 2026-05-10, 2026-04-29), all SLEEPING/stopped; each has an ACTIVE Railway domain; no volumes returned. | Same owner/source-repository confirmation, current traffic and logs, domain/DNS and API-client dependency checks, deployment history, and contract/business-owner confirmation. | No attached volume returned; nevertheless deletion removes live domain/service configuration. Snapshot source/configuration and define domain restoration before approval. | Named owner of each service must confirm; separate explicit approval must list all three IDs. |
| Detached `senpi-openclaw` volume `70f5cb39-7923-490e-85aa-b00c7b64c1f1` | **RETAIN** | READY, 71.844/500 MB, not pending deletion, no attached service; project usage is nonzero. | Identify data and owner; inspect backup inventory and recovery procedure without exposing data; verify no future/template/automation attachment; verify latest access and retention obligation. | **Unproven.** A volume can contain persistent data. Railway documents backups for volumes, and warns that wiping a volume deletes all backups; restore is project/environment scoped. Require a verified backup plus restoration test/plan first. | Data owner must confirm data-retention disposition; explicit approval must name this volume ID and the approved backup/rollback plan. |

The future cleanup execution work package must, in this order: (1) re-run the read-only inventory and collect exact IDs; (2) collect deployment/activity, domain/DNS, volume/backup, ownership and dependency evidence; (3) obtain owner confirmation; (4) document and validate backup/rollback; (5) obtain explicit approval naming the exact resources; and only then perform an approved, reversible-first operation. No candidate is `ELIGIBLE` in this audit. [Railway Backups](https://docs.railway.com/volumes/backups)

## Deployment gate for Supermemory Local

Before any Railway mutation, the implementing owner must approve all of the following:

1. Architecture decision: confirm Railway is permitted for the knowledge-base state path and reconcile it with OpenTag's Cloudflare-only state constraints and competing storage proposal.
2. Target isolation: approve the new project/environment/service IDs and account/workspace; do not attach this checkout to an existing project as a shortcut.
3. Data plan: define what must persist, select volume versus managed database, establish encryption/access controls, retention, backup cadence, restoration test, and deletion process. Do not treat the volume listing as a backup inventory.
4. Deployment contract: provide non-secret variable names and secret-injection ownership, image/build contract, health endpoint, domain policy, observability/alerting, and rollback version.
5. Explicit mutation approval: separately authorize project/service/environment/volume/domain creation and the first deployment. A successful deploy must be followed by deterministic health, retrieval, persistence, restart/rollback, and access-control acceptance tests.

This audit deliberately did not inspect variables or secret values, connect to databases, SSH into services, browse/download volume files, call application endpoints, stream logs, or execute mutation commands.

## Reproduction commands (read-only only)

These commands pin the audited CLI version so the evidence can be reproduced deterministically. A future refresh should first record the then-current official CLI version and explicitly update this report before changing the pin.

```bash
bunx @railway/cli@5.27.0 --version
bunx @railway/cli@5.27.0 whoami --json
bunx @railway/cli@5.27.0 project list --json
bunx @railway/cli@5.27.0 status --project <project-id> --environment production --json
bunx @railway/cli@5.27.0 service list --project <project-id> --environment production --json
bunx @railway/cli@5.27.0 domain list --project <project-id> --environment production --service <service-id> --json
bunx @railway/cli@5.27.0 volume --project <project-id> --environment <environment-id> list --json
bunx @railway/cli@5.27.0 usage projects --workspace 546abf5f-9447-4d89-84d3-5e5e08c809a0 --json
bunx @railway/cli@5.27.0 metrics --all --project <project-id> --environment production --since 7d --json
```
