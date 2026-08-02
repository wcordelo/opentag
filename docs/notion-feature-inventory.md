# Notion-derived OpenTag feature inventory

Status: **historical Notion audit reconciled with the merged connector/platform
work, the 2026-08-01 live rollout, and the credential-broker branch**

Updated: **2026-08-01**

The historical comparison used the source revisions recorded below. Current
implementation and deployment truth is in
[current-state.md](./current-state.md); this inventory remains the durable
mapping from daily Centaur findings to OpenTag decisions.
The isolated credential-broker branch extends the fail-closed boundary with an
optional Secrets Store custody adapter; no provider mapping or token is live.

The queue-backed effecter implementation is maintained in the isolated
`codex/weekly-platform-effecter` branch and remains fail-closed until an
approved provider adapter and custody boundary are configured.

## Scope and source availability

The requested Pacific window is **2026-07-22 through 2026-07-31**, inclusive.
The daily-review data source was fetched and its exact schema was queried. The
schema is:

- title: `Review`
- date: `Review Date`
- select: `Run Status` (`Completed`, `No Changes`, `Blocked`)
- numbers: `Migrate`, `Evaluate`, `Covered`, `Not Applicable`
- text: `Top Gaps`, `OpenTag Commit`, `Sync Commit`, `Centaur Range`
- system fields: `Created`, `Last Updated`

The exact database query returned three rows:

| Pacific date | Notion row | counts | Top gap summary |
|---|---|---:|---|
| Jul 24 | [daily row](https://app.notion.com/p/3a7344480094819fa257f377a8e6e4d1) | Migrate 0 / Evaluate 1 / Covered 0 / N/A 3 | Generic client-credentials broker |
| Jul 25 | [daily row](https://app.notion.com/p/3a834448009481c09da2e27fbaeaa952) | Migrate 1 / Evaluate 1 / Covered 0 / N/A 3 | Opus 5 aliases/effective selection; rollout provenance |
| Jul 28 | [daily row](https://app.notion.com/p/3ab344480094818696fdce54b87b1f81) | Migrate 2 / Evaluate 0 / Covered 2 / N/A 3 | Linear project/milestone writes; terminal Slack source skips |

The available standalone review pages were:

- [Jul 22](https://app.notion.com/p/3a5344480094816e92b6ddf5387f34cd)
- [Jul 23 cumulative record](https://app.notion.com/p/3a63444800948165b11bf46128387b40)
- [Jul 29](https://app.notion.com/p/3ac3444800948110a9f1d02edfbc71c3)
- [Jul 30](https://app.notion.com/p/3ad34448009481f983a8d97a9e3af11a)
- [Jul 31](https://app.notion.com/p/3af344480094813d8b44d3c8e761c2ad)

No database row or standalone daily-review page for **Jul 26** or **Jul 27**
was found. Those dates are unavailable source data, not zero-change reviews.
The [daily database](https://app.notion.com/p/3f174eb0c9b24c51aa28beeae39de4ef),
[data source](https://app.notion.com/p/3f174eb0c9b24c51aa28beeae39de4ef),
[historical baseline](https://app.notion.com/p/39d3444800948128b47cd1093c85e6fd),
and [OpenTag parent plan](https://app.notion.com/p/39a344480094810c8ba1f84c89f7168d)
were inspected for schema, historical context, and architecture boundaries.

The broader OpenTag page was also inspected: the [single-agent architecture
plan](https://app.notion.com/p/39a344480094810c8ba1f84c89f7168d), [vision
spec](https://app.notion.com/p/3af34448009481d09af0c42ec4ef14fe), [three-tier
router spec](https://app.notion.com/p/3af34448009481bcadfcdf87cb50355d),
[porting priorities](https://app.notion.com/p/3a9344480094817884dedb90cfb8c988),
[end-to-end implementation spec](https://app.notion.com/p/3ab34448009481ec96d0eebda0c30fa7),
the legacy [Centaur-to-Edge migration spec](https://app.notion.com/p/38d34448009481f58864e58be2a71c97),
and the qm, Nanocodex, and Buzz full-history review databases. The legacy
Centaur-to-Edge actor/Wasm/Nix design is superseded by the single-agent
Cloudflare architecture and is not an omitted implementation requirement.

## Current rollout reconciliation

The connector/platform/router items that were previously described as local or
blocked now have a precise evidence status:

- connector labels, grants, revocation, citations, platform provisioning,
  metering, memory requests, and effect leases are **synthetic-live**;
- native Nanocodex and Claudex are **live-verified through Slack**;
- router classification is **live-verified in shadow mode** with Tier 2 still
  dispatched;
- Drive and Linear remain **fail-closed** because the deployed bot has no
  `CONNECTOR_CREDENTIALS` broker/provider custody; and
- the Buzz receive route is **live fail-closed**, not authenticated-live.

The original Notion findings and dates are not rewritten. See the
[backfill reconciliation](../goal-outputs/multi-repo-parent-sync-architecture-backfill/CURRENT-STATE-RECONCILIATION.md)
for the complete document-by-document status map.

## Every finding in the available window

### Jul 22 — two Migrate, one Evaluate, one Covered, two N/A

- **Migrate — Google Drive full-text search.** Centaur added bounded
  `fullText contains` search, escaping, and tests. OpenTag now has a bounded
  Drive connector and citation output on merged main, but live use still
  requires a deployed credential broker, Google OAuth/custody, ACL policy, and
  a non-production validation workspace.
- **Migrate — secret-shaped harness-output redaction.** This is implemented in
  the merged OpenTag line and covered by harness/output-redaction tests. It
  protects persisted events, diagnostics, and delivery while preserving normal
  hyphenated words.
- **Evaluate — provider-neutral coding progress/task events.** OpenTag now has
  bounded harness progress rendering, but the full Centaur Nanocodex/subagent
  event matrix is not a required OpenTag product feature. Decide whether coding
  turns need richer task progress before expanding the wire contract.
- **Covered — sticky harness/model selection.** Existing explicit, sticky,
  channel, and deployment precedence is the OpenTag equivalent.
- **N/A — Nanocodex provider/subagent matrix.** It conflicts with the current
  Claude-Code-only harness product boundary.
- **N/A — Centaur operator implementation changes.** Google CLI, K8s,
  iron-proxy, Rails, workflow-image, and Granola-console changes are not
  portable OpenTag behavior.

### Jul 23 — one Migrate, two Evaluate, two N/A

- **Migrate — bounded administrator prompt composition for coding.** This gap is
  already implemented on OpenTag `origin/main` and covered by the current
  branch's contract/worker tests. The image-owned `SYSTEM_PROMPT.md` is the
  deployment base; `/putAdminConfig` is the only overlay mutation path; the
  channel-scoped overlay is tagged `workspace_admin`, digest-checked, revisioned,
  bounded to 64 KiB, and appended after the base. `/putChannelContext` and the
  legacy `/putConfig` path reject overlay writes, so repository/user content
  cannot become authoritative harness instructions. No duplicate feature work
  was selected; the inventory and tests were updated to record the existing
  implementation accurately.
- **Evaluate — scoped read-only X connector.** Only add this if X research is a
  product requirement. It would need connector grants, a broker, read-only
  bounded pagination/media/reference normalization, item-level errors, and
  citation/ACL tests.
- **Evaluate — immutable connector-policy labels.** This foundation is now
  implemented on merged main in `edge/src/connectors/authorization.ts`, with
  credential references, access-bundle revisions, revocation, and citation
  binding. A real broker and custody service remain outstanding.
- **N/A — Python durable-workflow event waits.** OpenTag uses Durable Objects.
- **N/A — Codex-specific instruction-size configuration.** OpenTag’s pinned
  Claude Code harness does not need that Centaur-specific setting.

### Jul 24 — one Evaluate, three N/A

- **Evaluate — generic client-credentials token broker.** Merged main has the
  secret-free broker client and durable effect handoff. The isolated branch
  adds a fail-closed broker Worker with platform-state revalidation, provider
  and scope policy, separate internal custody authentication, and an optional
  Secrets Store-backed `CUSTODY` Worker. It still has no configured store,
  provider OAuth exchange, rotation scheduler, or approved production custody
  policy. Do not put provider tokens in OpenTag Durable Objects, Wrangler vars,
  queues, or access bundles.
- **N/A — Kubernetes observable-resource labels.** No Kubernetes/iron-proxy
  equivalent is needed; Cloudflare structured logs and trace correlation are
  the adaptation.
- **N/A — Dependabot configuration.** Repository maintenance, not product
  behavior.
- **N/A — Rails dependency refresh.** No Rails runtime exists in OpenTag.

### Jul 25 — one Migrate, one Evaluate, three N/A

- **Migrate — Claude Opus 5 shortcuts and effective-selection footnote.** The
  merged line includes `opus-5` and `opus-5-fast` aliases and effective
  harness/model provenance in the harness progress path. A live Slack smoke
  remains useful after the next deployment.
- **Evaluate — deterministic controlled rollout/provenance.** OpenTag has
  runtime-selection provenance, but no stable cohort assignment or persisted
  rollout percentage. Add this only when a new harness/model version actually
  needs gradual rollout; use a stable thread hash and durable assignment.
- **N/A — dependency-only maintenance.** Centaur api-rs, harness, and docs
  dependency changes do not map to OpenTag’s TypeScript/Cloudflare graph.

### Jul 28 — two Migrate, two Covered, three N/A

- **Migrate — preserve Linear project/milestone through confirmed writes.** The
  merged line implements project and milestone fields in the durable approval,
  exact digest, Linear mutation, and tests. It remains disabled for production
  until a broker/OAuth grant and test workspace are available.
- **Migrate — terminal skips for inaccessible Slack knowledge sources.** The
  merged line maps non-member/non-found Slack source failures to durable
  non-retryable skipped outcomes rather than indefinite retries.
- **Covered — reader-scoped company context.** OpenTag’s source policy,
  channel-bundle reauthorization, and signed exact-scope grants provide the
  Cloudflare equivalent.
- **Covered — channel-scoped operator policy.** Access bundles, tool/policy
  gates, and redacted permission snapshots cover the portable behavior.
- **N/A — automatic Slack channel joining.** OpenTag has no channel-create/join
  lifecycle.
- **N/A — Rails console UI and role-management plumbing.** No Rails console is
  in the OpenTag product boundary.
- **N/A — unconditional Kubernetes/Rails Solid Queue worker.** No equivalent
  Cloudflare worker-host change is warranted.

### Jul 29 — no findings

The review explicitly reports zero Migrate, Evaluate, Covered, and N/A findings
for an empty incremental Centaur range. It is evidence of no new upstream
change, not evidence that all earlier gaps are complete.

### Jul 30 — one Migrate, one Covered, three N/A

- **Migrate — explicit mentions gate channel-thread steering and Stop (historical
  review point).** The Jul 30 review recorded mention-only steering and an
  exact-mentioned Stop. The current reconciliation supersedes the ordinary
  reply portion: the bot reads every human thread reply, routes clear
  questions/action requests/problem reports without a tag, keeps passive
  conversation as history, and still requires an exact bot mention for Stop.
  Duplicate `app_mention`/threaded `message` delivery is rejected before
  admission so it cannot create a stale active-turn warning. See
  `docs/current-state.md` for live evidence.
- **Covered — explicit reasoning intent and supported-model validation.**
  OpenTag’s stricter explicit-only reasoning policy is equivalent or safer.
- **N/A — Rails console secret replacement/sync snapshots.** No Rails config
  cache exists in OpenTag.
- **N/A — Rails security patch.** No Rails dependency exists.
- **N/A — api-rs dependency bump.** No Centaur Rust control plane exists.

### Jul 31 — one Evaluate, three Covered, one N/A

- **Evaluate — authorized bounded raw knowledge/context queries.** The merged
  line implements named, server-owned `query_template` operations with fixed
  statements, bounded results, verified team scope, and redacted lease tokens.
  Arbitrary SQL, table names, filters, ordering, and caller-chosen addressing
  remain prohibited.
- **Covered — output recovery after ownership handoff.** SessionEventDO replay
  and render-obligation recovery provide the Cloudflare equivalent.
- **Covered — source-scoped knowledge authorization.** Exact team/project/
  channel scopes and reader-policy references are already enforced.
- **Covered — Markdown links in streamed output.** Slack stream rendering and
  tests cover the behavior.
- **N/A — Centaur workflow-host and CI internals.** Python workflow-host and
  api-rs durability changes are outside OpenTag’s runtime.

## Consolidated implementation status

### Implemented locally or already merged

- explicit rich mention gating and terminal inaccessible-source skips;
- secret-shaped harness output redaction;
- Opus 5 aliases and effective runtime provenance;
- administrator-owned, bounded coding prompt composition with base-before-channel
  precedence, digest/revision checks, and source separation;
- immutable connector labels, credential references, access-bundle revisions,
  terminal revocation, and citation authorization;
- bounded Drive search after those foundations;
- Linear project/milestone preservation through exact human approval;
- trace correlation using durable execution identity;
- bounded named raw KnowledgeDO query templates;
- three-tier classifier in shadow mode with workspace-scoped durable dispatch,
  outcome, and feedback measurement while dispatch remains Tier 2;
- provisioning, identity/credential references, marketplace/OAuth, usage meter,
  memory-policy/deletion contracts; and
- the merged `platform-state` metadata ledger and the new secret-free
  `platform_effect_intents` handoff with bounded leases,
  retries, idempotency, and terminal completion/failure/cancellation. Local
  state transitions emit intents for provisioning, custody/OAuth revocation and
  rotation, marketplace changes, billing meters, and memory deletion.
- the isolated credential-broker Worker boundary with internal authentication,
  tenant/provider/scope revalidation, and an external custody service seam;
- the optional Secrets Store custody Worker, which validates the same immutable
  labels and reference/version pair before reading a named secret binding.
  The merged baseline also includes an authenticated effecter runner/Worker,
  metadata-only queue wakeup/retry, and an admin recovery wake route; all
  provider adapters remain fail-closed when unconfigured.
- source-scoped memory deletion receipts bound to the request epoch; requests
  reach `completed` only after every source reports `deleted` or `not_found`,
  while failed receipts remain explicit and terminal; and a fail-closed,
  source-scoped provider adapter boundary that still carries no memory content.
- receipt-bound provisioning step advancement; a tenant cannot become `active`
  from a bare outcome and each required footprint retains an opaque external
  receipt before activation.

### Still required before “everything” is live

1. **Credential custody:** the broker Worker and optional Secrets Store adapter
   are implemented locally. Approve that adapter or choose external KMS,
   wrapped Durable Object envelope, or self-hosted custody; configure
   reference/version mappings, provider OAuth/token rotation, scope checks,
   revocation propagation, and a safe non-production smoke. No credential
   store or provider mapping is currently configured.
2. **Provisioning/identity:** the local tenant ledger now requires an external
   receipt for every required provisioning step. Choose the tenant locator and
   isolation model, deploy the bootstrap/effect worker and queue after an
   adapter is approved, establish identity/key custody, and supply real
   receipts for every DO, bundle, OAuth, and identity step. The metadata ledger
   and platform binding are deployed; the external provider worker is not.
3. **OAuth/marketplace:** choose callback ownership and allowlisted origins,
   nonce/state handling, curated trust-review authority, and connector version
   lifecycle. The ledger is ready; the external effecter is not.
4. **Billing:** choose the billing source of truth, plan/overage policy,
   metering reconciliation, and enforcement behavior. Meter intents exist but
   no billing provider is called.
5. **Memory deletion:** the durable receipt ledger, source/epoch checks, and a
   provider-independent source-scoped adapter boundary now exist. Still choose
   retention/compliance guarantees, provider custody, and the non-production
   namespace before configuring the adapter that performs source-by-source
   deletion and submits proof; the ledger and boundary do not inspect or delete
   memory themselves.
6. **Router rollout:** collect enough shadow measurements, then add Tier 1
   knowledge quality gates and fallback/synthesis behavior, product-facing
   escalation affordance, and an explicit rollout gate before enabling
   dispatch. The workspace-scoped measurement and misroute ledgers now exist;
   they do not enable routing by themselves.
7. **Prompt composition follow-up:** the current base-plus-channel overlay is
   implemented. If a separate deployment text layer is required later, add it
   only with an explicit source, precedence, CAS/revision, and rollout decision;
   do not make repository files authoritative prompts.
8. **Optional product decisions:** X connector, richer provider-neutral task
   events, and deterministic harness/model cohort rollout should remain
   decisions, not automatic ports.

## Recommended order

1. Approve custody, tenancy, OAuth callback, marketplace trust, billing, and
   deletion ownership.
2. Deploy and smoke-test the credential broker/effect worker against a test
   provider and test tenant; keep all live provider secrets outside OpenTag.
3. Enable Drive and Linear only for explicitly granted test workspaces.
4. Measure router shadow traffic and implement gates before changing dispatch.
5. Revisit X, richer progress, prompt composition, and rollout cohorts based on
   product demand.

The historical baseline remains unchanged. The audit did not create another
Notion database or append to the baseline.
