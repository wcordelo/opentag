# OpenTag — Centaur Gap Implementation SPEC

Status: **Ready for `/goal` implementation**
Date: **2026-07-15**
Target repository: OpenTag repository root
Source comparison: Centaur daily gap reviews through fork sync `14c6577`

## Goal objective

Use this exact objective for the implementation run:

> Implement `docs/centaur-gap-implementation-spec.md` end to end in OpenTag. Preserve unrelated working-tree changes. Complete the three feature tracks—permission introspection, channel runtime defaults, and trusted rich-payload Slack mentions—plus their tests, documentation, validation, and a fresh adversarial review. Do not deploy, reinstall the Slack app, mutate Cloudflare configuration, commit, push, or open a PR without explicit approval. Maintain `goal-outputs/centaur-gap-implementation/PROGRESS.md` as the durable checkpoint.

## 1. Outcome

OpenTag will gain three portable Centaur capabilities:

1. A redacted, read-only view of the exact permissions effective for an agent turn, available to the edge agent, operators, and the Claude Code harness.
2. Per-channel model and harness defaults, with explicit and sticky thread selections retaining higher precedence.
3. Fail-closed Slack triggering when an approved automation mentions OpenTag only inside Block Kit or legacy attachments.

The implementation is complete only when each capability is wired through its actual production path, covered by focused and integration tests, documented, and independently reviewed against OpenTag's durability, authorization, and Stop invariants.

## 2. Scope

### 2.1 In scope

- Effective access-bundle and policy introspection.
- Exact allowed and denied edge-tool names.
- Redacted MCP endpoint and secret-reference metadata.
- Turn runtime selection and its source: explicit, sticky thread, channel default, or deployment default.
- Harness-safe permission projection through the authenticated turn envelope.
- A local `opentag permissions` command inside the Claude Code container.
- Operator inspection through an authenticated, no-store admin endpoint.
- Channel defaults persisted by `WorkspaceConfigDO`.
- Backward-compatible `/config` runtime subcommands.
- Trusted Slack bot/app allowlisting by exact Slack identifiers.
- Bounded extraction of mentions and display text from raw Slack blocks and attachments.
- A distinct non-human request actor that cannot inherit human identity, GitHub attribution, or mutation authority.
- Metrics/logging sufficient to explain why a default or automation trigger was selected or rejected.
- Product, operations, extension, and Centaur-port documentation updates.

### 2.2 Explicitly out of scope

- A Rails-style operator console.
- Hosted MCP OAuth redirects.
- User-authorized private-channel history synchronization.
- Granola, Airtable, or company-context ingestion.
- Codex, Amp, Bedrock, or Meta runtime enablement.
- Making `-rsn` functional; it remains visibly unsupported while no Codex runtime exists.
- New Slack OAuth scopes or an app reinstall.
- Deployment, production configuration, live Slack messages, commits, pushes, PRs, or external mutations.

## 3. Binding constraints

These constraints are requirements, not guidance:

1. Read root `AGENTS.md`, `DECISIONS.md`, the current implementation, and nearer instructions before editing.
2. Run `git status --short --branch` before changes. Never reset, stash, format, stage, or rewrite unrelated work.
3. The current OpenTag tree may contain uncommitted remediation work in target files. Treat that work as user-owned baseline state. Inspect the diff before editing and record overlaps in `PROGRESS.md`.
4. Slack Events API remains the only ingress. Do not add Socket Mode or another bot process.
5. Every accepted turn must be durably pre-admitted before its first profile, config, Slack API, or runtime await.
6. Trusted automation is not a human requester. It cannot receive human-only mutation rights, approve remote git, create a PR, or produce a valid `Prompted by:` attribution.
7. Permission introspection is informational only. Authorization continues to use the real access-bundle, active-turn, effect, egress, and HITL enforcement paths.
8. Permission output must never contain secret values, bearer tokens, authorization headers, cookies, URL userinfo, URL query strings, URL fragments, raw Slack payloads, or unbounded configuration.
9. Channel defaults are defaults, not sticky state. They must never be written to `thread:overrides:*` merely because a turn used them.
10. Unsupported or invalid runtime configuration fails visibly or is rejected at configuration time. It must not silently fall back to another runtime.
11. Trusted rich mentions must use exact allowlist identity matching and exact mention matching. Natural-language names and fuzzy app matching are forbidden.
12. Slack redelivery must reuse the existing stable event identity and durable dedup path.
13. Existing Stop, render, effect, and rejection fences remain authoritative.
14. No deployment or external activation is part of this goal.

## 4. Current-state evidence

| Capability | Current OpenTag state | Primary seams |
| --- | --- | --- |
| Permission enforcement | Access bundles filter tools and policies remove memory/task tools. Harness egress separately enforces repository, credential, and remote-write rules. There is no common redacted inspection surface. | `edge/src/config/access-bundle.ts`, `edge/src/config/workspace-config-do.ts`, `edge/src/tools/guard.ts`, `edge/workers/sandbox/src/egress-policy.ts` |
| Thread runtime selection | Inline flags are stripped and model/harness values persist per thread. Channel configuration contains prompt, policies, and bundle only. | `edge/src/slack/overrides.ts`, `edge/src/store/thread-overrides.ts`, `edge/src/agent-turn.ts`, `edge/src/config/workspace-config-do.ts` |
| Rich Slack mentions | Ingress accepts `app_mention`, DMs, and subscribed thread replies. Bot-only messages are rejected and mentions nested only in blocks/attachments do not trigger. | `edge/src/slack/ingress-normalize.ts`, `edge/src/slack/pre-admit-turn.ts`, `edge/src/slack/cloudflare-slack-adapter.ts` |
| Requester identity | Request context assumes a Slack requester ID and profile enrichment calls `users.info`. | `edge/src/request-context.ts`, `edge/src/agent-turn.ts` |
| Harness inspection | The harness receives a validated turn envelope but no permission snapshot. | `edge/src/harness/client.ts`, `edge/workers/sandbox/turn-contract.ts`, `edge/workers/sandbox/src/router.ts`, `edge/workers/sandbox/harness-server.ts` |

Centaur evidence that motivated this work:

- `c86576c`: sandbox-scoped, redacted permission query.
- `f8fefed`: agent-facing permission inspection CLI.
- `6458e15`: per-channel model/harness defaults.
- `8c4e21b`: rich-payload Slack mention fallback behind existing policy checks.

Centaur's Rails, Postgres, iron-proxy, and Kubernetes implementations are reference evidence only. Do not port those runtime choices.

## 5. Shared contracts

### 5.1 Request actor

Replace the assumption that every accepted Slack turn is human-authored with an explicit actor union:

```ts
export type RequestActor =
  | {
      kind: "slack_user";
      userId: string;
    }
  | {
      kind: "slack_automation";
      botId?: string;
      appId?: string;
      displayName?: string;
    };
```

Rules:

- At least one of `botId` or `appId` is required for `slack_automation`.
- `RequestContext` stores `actor`; `requesterId` may remain temporarily as a compatibility field derived from `userId`, `app:<id>`, or `bot:<id>`.
- `ensureRequesterProfile()` runs only for `slack_user`.
- `buildRequesterContextBlock()` may identify an automation as a source, but must not emit `Prompted by:` for it.
- Automation actors receive the fixed safe-tool ceiling in §5.4 even if the channel bundle permits more.
- Stop commands, remote-git HITL, PR creation, user-email defaults, and user-attributed writes require `slack_user`.

### 5.2 Runtime defaults

Extend `WorkspaceChannelConfig`:

```ts
export type ChannelRuntimeDefaults = {
  harnessType?: "claudecode";
  model?: string;
};

export type WorkspaceChannelConfig = {
  // existing fields
  runtimeDefaults?: ChannelRuntimeDefaults;
};
```

Effective precedence is resolved per field:

1. Explicit flags on the current message.
2. Sticky thread override.
3. Channel runtime default.
4. Runtime-specific deployment default.

Rules:

- Reasoning is not configurable in channel defaults.
- A configured model must be valid for the configured harness. For this scope, a channel model requires `harnessType: "claudecode"`.
- A channel with `harnessType: "claudecode"` and no model uses the harness's own configured default.
- `AGENT_MODEL` applies only when the effective path is AG-UI.
- A channel default is never persisted into sticky thread storage.
- Existing sticky values intentionally continue to mask a changed channel default until explicitly overwritten or expired.
- Configuration parsing rejects unknown fields, unsupported harnesses, unsafe model IDs, and model-without-harness combinations.

The resolver must expose provenance:

```ts
type RuntimeSelectionSource = "explicit" | "sticky" | "channel" | "deployment";

type ResolvedRuntimeSelection = {
  harnessType?: "claudecode";
  model?: string;
  harnessSource: RuntimeSelectionSource;
  modelSource: RuntimeSelectionSource;
};
```

### 5.3 Permission snapshot

Create a versioned JSON contract. Keep the canonical edge type in `edge/src/permissions/contract.ts`. The isolated harness package may mirror the structural type in `turn-contract.ts`, but parity must be locked by shared fixtures/tests.

```ts
export type PermissionSnapshotV1 = {
  version: 1;
  scope: {
    teamId: string;
    channelId: string;
    conversationKey?: string;
    executionId?: string;
    actorKind: "slack_user" | "slack_automation" | "operator";
  };
  channelAccess: {
    bundleId: string;
    metadataVisibility: "full_names" | "restricted";
    allowedTools: string[];
    deniedTools: string[];
    policies: {
      allowMemoryWrite: boolean;
      allowTasks: boolean;
    };
    mcpEndpoints: Array<{ origin: string; path: string }>;
    secretRefs: string[];
  };
  runtime: {
    harnessType?: "claudecode";
    model?: string;
    harnessSource: "explicit" | "sticky" | "channel" | "deployment";
    modelSource: "explicit" | "sticky" | "channel" | "deployment";
    harnessConnected: boolean;
  };
  sandbox?: {
    network: "denied_by_default";
    credentialExposure: "sentinel_only";
    allowedRepoHosts: string[];
    allowedRepoOrgs: string[];
    remoteGitApproved: boolean;
    createPullRequest: boolean;
  };
  generatedAt: string;
};
```

Redaction and bounding rules:

- Tool, secret-reference, host, and organization arrays are sorted, unique, and capped at 200 entries.
- Each string is capped at 256 characters.
- MCP URLs expose only normalized `https:` origin and pathname. Drop userinfo, query, and fragment. Invalid/non-HTTPS endpoints render as `{ origin: "[invalid]", path: "" }` or are omitted with a bounded warning.
- `secretRefs` contains configured names only, never resolved values.
- Human and authenticated operator snapshots use `metadataVisibility: "full_names"`. Automation snapshots use `restricted`, with `mcpEndpoints` and `secretRefs` empty, so an alert payload cannot enumerate integration configuration through the introspection tool.
- No snapshot includes Slack tokens, `ADMIN_SECRET`, harness auth, Anthropic/OpenAI/GitHub tokens, request headers, raw environment values, or raw access-bundle JSON.
- The serialized snapshot is capped at 64 KiB at every transport boundary.
- The snapshot is never consulted to authorize an operation.

### 5.4 Automation safe-tool ceiling

Define a code-owned maximum set for automation-authored turns:

```ts
export const AUTOMATION_SAFE_TOOLS = new Set([
  "lookup_slack_user",
  "read_thread",
  "issue_list",
  "page_list",
  "show_status",
  "show_links",
  "show_incident",
  "memory_search",
  "show_permissions",
]);
```

The effective automation tool set is the intersection of the channel's ordinary allowed tools and `AUTOMATION_SAFE_TOOLS`.

The initial implementation must deny `confirm_write`, `memory_write`, `start_task`, `research_progress`, `react_message`, remote git, PR creation, and any newly added tool not explicitly present in the safe set.

`show_permissions` is a reserved, always-available, read-only meta tool for accepted turns. Custom bundles cannot hide it because users and agents need to understand denials. Its output remains redacted and execution-fenced.

### 5.5 Trusted Slack trigger allowlist

Add optional Worker variables:

```ts
SLACK_BOT_USER_ID?: string;
SLACK_TRUSTED_TRIGGER_ACTORS?: string;
```

`SLACK_TRUSTED_TRIGGER_ACTORS` is a comma/whitespace-separated list containing only:

- `bot:B...`
- `app:A...`

Rules:

- Invalid entries are ignored with one bounded startup warning.
- If the allowlist is non-empty but `SLACK_BOT_USER_ID` is missing or malformed, trusted rich triggering is disabled and startup/readiness reports the misconfiguration.
- Matching uses only exact raw `bot_id`, `bot_profile.id`, `app_id`, or `bot_profile.app_id` values present in the verified event. Do not perform a Slack API lookup before pre-admission.
- A matching actor must also contain an exact `<@SLACK_BOT_USER_ID>` or labeled `<@SLACK_BOT_USER_ID|...>` mention inside `blocks` or `attachments`.
- A top-level text mention already delivered as `app_mention` continues through the existing path and must not double-trigger.
- The OpenTag bot's own `bot_profile.user_id === SLACK_BOT_USER_ID` is always rejected even if misconfigured into the allowlist.
- Bot DMs without a rich mention, message edits, deletions, joins, broadcasts, and other subtypes remain rejected. `bot_message` is accepted only through this exact trusted-rich path.

## 6. Execution plan

Each task below has a required deliverable, dependencies, and acceptance criteria. Complete tasks in order unless a dependency explicitly allows parallel work.

### Phase 0 — Baseline, checkpoint, and overlap audit

#### Task 0.1 — Establish durable goal state

Deliverable:

- `goal-outputs/centaur-gap-implementation/PROGRESS.md`

Dependencies: none.

Required contents:

- objective and spec path;
- starting branch and commit;
- complete `git status --short --branch` snapshot;
- target-file overlap notes for existing uncommitted changes;
- numbered task ledger matching this spec;
- validation commands and results;
- blockers and next action;
- explicit statement that deployment and git publication are not authorized.

Acceptance criteria:

- The file exists before implementation edits.
- Its counter matches its numbered completed rows.
- Existing dirty files are attributed as pre-existing or task-owned without guessing.

#### Task 0.2 — Capture current behavior

Deliverable:

- A short baseline section in `PROGRESS.md` with focused existing tests and current outcomes.

Dependencies: Task 0.1.

Run at minimum when dependencies are installed:

```bash
cd <opentag-repo>
pnpm check-types
pnpm test
cd edge
npm run typecheck
npm test -- --run test/product-spine.test.ts test/pre-admit-turn.test.ts test/cloudflare-slack-adapter.test.ts test/thread-overrides.test.ts test/overrides.test.ts
```

Acceptance criteria:

- Failures are recorded exactly and not attributed to the new work before changes exist.
- No formatter or broad rewrite is run.

### Phase 1 — Shared permission and actor contracts

#### Task 1.1 — Add request actor support

Deliverables:

- `RequestActor` contract.
- Actor stored in immutable request and pre-admission context.
- Human compatibility behavior preserved.
- Non-human requester context rendering.

Primary files:

- `edge/src/request-context.ts`
- `edge/src/slack/pre-admit-turn.ts`
- `edge/src/slack/cloudflare-slack-adapter.ts`
- `edge/src/agent-turn.ts`

Dependencies: Phase 0.

Acceptance criteria:

- Existing human events produce `slack_user` with unchanged stable execution IDs.
- Automation actors never call `users.info`.
- Automation requester context contains no `Prompted by:` line.
- Automation cannot satisfy the harness PR-attribution validator.
- Request actor data is bounded and contains no raw event.

#### Task 1.2 — Add permission snapshot builder and binding

Deliverables:

- `edge/src/permissions/contract.ts`
- `edge/src/permissions/snapshot.ts`
- `edge/src/permissions/context.ts` or an equivalent WeakMap-based per-invocation binding.

Dependencies: Task 1.1.

Implementation requirements:

- Build from the exact loaded `WorkspaceChannelConfig`, `AccessBundle`, resolved tool set, runtime selection, request actor, and execution identity.
- Bind the immutable snapshot to the concrete thread/turn object; do not use one mutable module-level current snapshot.
- Derive denied tools from `ALL_EDGE_TOOL_NAMES` after policy and automation ceilings are applied.
- Apply all redaction and bounds from §5.3.

Acceptance criteria:

- Concurrent turns cannot observe each other's snapshot.
- Snapshot ordering is deterministic.
- URL credentials/query/fragment and secret values never appear.
- Oversized inputs are safely bounded.

### Phase 2 — Permission introspection surfaces

#### Task 2.1 — Add the edge `show_permissions` tool

Deliverables:

- `show_permissions` in `edge/src/tools/index.ts`.
- Reserved meta-tool treatment in the tool-resolution path.
- Updated built-in tool prompt text.

Dependencies: Task 1.2.

Behavior:

- No parameters.
- Requires the exact active turn to remain pending.
- Returns the bound redacted snapshot as structured JSON.
- Does not fetch secrets or independently reconstruct authorization.

Acceptance criteria:

- Available under the default and a restrictive custom bundle.
- Returns exact allowed/denied tool results after policy filtering.
- An automation turn sees the automation ceiling in its own snapshot.
- A stopped or replaced turn cannot call it successfully.

#### Task 2.2 — Add the operator endpoint

Deliverable:

- `GET /admin/permissions?teamId=<id>&channelId=<id>` in `edge/src/worker.ts`.

Dependencies: Task 1.2.

Behavior:

- Protected by existing `requireAdminAuth()`.
- Loads actual workspace/channel config and bundle.
- Returns a configuration-level snapshot with actor kind `operator`; turn-only fields are absent.
- Sends `Cache-Control: no-store`.
- Rejects missing/oversized identifiers with 400.
- Never accepts a secret override in query parameters.

Acceptance criteria:

- Missing/invalid admin authentication is rejected.
- Response is redacted and deterministic.
- Unknown bundle fallback behavior matches actual turn behavior.

#### Task 2.3 — Project permissions into the Claude harness

Deliverables:

- Optional bounded permission snapshot field in `edge/src/harness/client.ts` and `edge/workers/sandbox/turn-contract.ts`.
- Outer sandbox Worker enrichment using actual egress and repo configuration.
- Per-execution permission file and `OPENTAG_PERMISSIONS_FILE` in `edge/workers/sandbox/harness-server.ts`.
- `opentag permissions` command installed by `containers/harness/Dockerfile`.

Dependencies: Task 1.2.

Implementation requirements:

- The bot supplies only the redacted channel/runtime portion.
- The authenticated sandbox Worker validates the snapshot and overwrites/adds the `sandbox` section from its own validated request and configuration.
- The container command prints JSON from the per-execution snapshot file.
- The file is informational. Neither the harness server nor egress policy may authorize from the file.
- The file lives inside the disposable execution home and is removed with that home.
- The command exits nonzero with a clear message when no snapshot exists.

Acceptance criteria:

- Invalid, oversized, or secret-shaped snapshots are rejected before the container runs.
- `opentag permissions` prints the expected redacted data during a turn.
- Repository code cannot use edits to the file to obtain additional network, credential, git, or tool rights.
- The container still receives sentinel credentials only.

#### Task 2.4 — Permission tests and documentation

Deliverables:

- Focused unit and integration tests.
- Updates to `docs/extending.md`, `docs/operations.md`, and `docs/centaur-port.md`.

Dependencies: Tasks 2.1–2.3.

Minimum tests:

- deterministic snapshot and redaction;
- restrictive bundle allowed/denied lists;
- policy removal of memory/task tools;
- automation safe-tool ceiling;
- admin auth and no-store response;
- concurrent snapshot isolation;
- turn-contract validation and 64 KiB cap;
- harness file/CLI happy path and missing-snapshot failure;
- no secret values in serialized fixtures.

Acceptance criteria:

- Documentation says inspection is non-authoritative.
- Documentation names the exact operator endpoint and harness command.
- Documentation does not claim production activation.

### Phase 3 — Channel runtime defaults

#### Task 3.1 — Extend configuration storage safely

Deliverables:

- `ChannelRuntimeDefaults` in `edge/src/config/access-bundle.ts`.
- Additive `WorkspaceConfigDO` schema evolution and serialization.
- Pure validation/normalization helper.

Dependencies: Phase 2 complete.

Implementation requirements:

- Add nullable `default_harness_type` and `default_model` columns, or an equivalently bounded versioned JSON column.
- Migration must work for both a fresh DO and an existing DO with the current table.
- Use schema inspection or a version table so repeated initialization is idempotent.
- Preserve prompt, policies, and access bundle during runtime-only updates.

Acceptance criteria:

- Existing rows load with `runtimeDefaults` absent.
- Fresh and upgraded schemas behave identically.
- Invalid harness/model combinations return 400 or an explicit DO validation error; they are never stored.
- Team fallback and channel override behavior remains unchanged.

#### Task 3.2 — Refactor runtime selection precedence

Deliverables:

- `resolveThreadOverrides()` accepts validated channel defaults and returns provenance.
- All production turn paths load channel config before final effective runtime resolution.

Primary paths:

- ordinary agent turns in `edge/src/agent-turn.ts`;
- mention-triggered research in `edge/src/bot-engine.ts`;
- `/research` in `edge/src/commands/index.ts`;
- harness request construction;
- AG-UI model selection.

Dependencies: Task 3.1.

Acceptance criteria:

- Explicit > sticky > channel > deployment precedence is proven per field.
- Channel defaults do not create or update `thread:overrides:*`.
- A sticky selection in one thread does not leak to another thread or channel.
- AG-UI `AGENT_MODEL` is not sent to a selected Claude harness.
- A channel-selected Claude harness fails visibly when the harness is disconnected and does not fall back to AG-UI.
- Unsupported reasoning remains a visible rejection and is never saved.
- Permission snapshots report the exact effective value and source.

#### Task 3.3 — Add backward-compatible configuration surfaces

Deliverables:

- `/config runtime show`
- `/config runtime set --harness claude-code [--model <id-or-alias>]`
- `/config runtime clear`
- Existing `/config <system prompt>` behavior preserved.
- Admin `/admin/config` validation uses the same normalizer.
- Slack manifest usage text and operations docs updated.

Dependencies: Tasks 3.1–3.2.

Security and UX requirements:

- Only exact `runtime show|set|clear` prefixes enter runtime parsing; other text remains a system prompt.
- Configuration writes retain the existing durable shortcut/effect fence.
- Runtime configuration commands require a `slack_user` actor; automation actors cannot invoke or authorize them.
- Confirmation reports stored defaults and warns that existing sticky thread choices have higher precedence.
- `show` is read-only and displays no secret data.

Acceptance criteria:

- Prompt-only config remains byte-compatible for existing tests.
- Runtime set/show/clear round-trip through the DO.
- Malformed flags do not partially update configuration.
- A stopped `/config runtime set` cannot commit after Stop.

#### Task 3.4 — Runtime-default tests and documentation

Deliverables:

- Focused runtime-default unit/integration tests.
- Updated runtime-default documentation in the files listed below.

Dependencies: Tasks 3.1–3.3.

Minimum tests:

- fresh and migrated DO schemas;
- global team default and channel-specific override;
- precedence matrix;
- channel defaults excluded from sticky persistence;
- harness-disconnected visible failure;
- admin and Slack config validation parity;
- flags-only confirmation uses the effective result;
- runtime provenance in permission snapshots;
- concurrent channels use different defaults safely.

Documentation updates:

- `docs/extending.md`: configuration contract and precedence.
- `docs/operations.md`: setting, inspecting, clearing, and troubleshooting defaults.
- `docs/centaur-port.md`: classify as adapted and implemented only after tests pass.

Acceptance criteria:

- No documentation advertises unsupported reasoning or runtimes.
- Examples use neutral channel IDs and model placeholders.

### Phase 4 — Trusted rich-payload Slack mentions

#### Task 4.1 — Add bounded rich-payload parsing

Deliverables:

- `edge/src/slack/rich-display-text.ts` or equivalent pure module.
- Exact rich mention detection and display-text extraction.

Dependencies: Task 1.1.

Implementation requirements:

- Inspect only `blocks` and `attachments` from verified Slack event records.
- Support common Block Kit text objects, rich-text user elements, attachment `pretext`, `text`, `fallback`, `title`, and nested fields/elements.
- Bound recursion depth, visited nodes, array length, individual strings, and aggregate output. Target aggregate display text cap: 24,000 characters.
- Detect both `<@U...>` and `<@U...|label>` tokens.
- Preserve enough surrounding alert text to form the prompt, then strip the OpenTag mention.
- If the cleaned rich display text is empty after stripping the mention, reject the event rather than running an empty automation prompt.
- Do not stringify the entire raw event.

Acceptance criteria:

- Alertmanager-style attachment pretext triggers.
- Block Kit user elements and text tokens trigger.
- Malformed, cyclic test objects, extreme nesting, and oversized arrays terminate safely.
- A mention present only in an unrelated field does not trigger.

#### Task 4.2 — Parse and validate the trusted actor allowlist

Deliverables:

- Env types in `edge/src/env.ts`.
- Pure allowlist parser and matcher.
- Bot construction wiring and documented Wrangler variable examples.

Dependencies: Task 4.1.

Acceptance criteria:

- Only exact `bot:B...` and `app:A...` entries are accepted.
- Empty/unset allowlist disables the feature.
- Missing `SLACK_BOT_USER_ID` disables the feature even with an allowlist.
- Own-bot messages are always rejected.
- Raw app/bot mismatch is rejected without API lookup.
- Invalid configuration logs identifiers only, never the raw event.

#### Task 4.3 — Admit trusted automation through the durable path

Deliverables:

- Trusted-rich identity extraction in `preAdmissionIdentityForEvent()`.
- Equivalent normalization in `normalizeSlackEvent()`.
- Automation actor binding through adapter handoff.
- Existing stable event identity and active-turn registration reused.

Dependencies: Tasks 4.1–4.2 and Task 1.1.

Required ordering:

1. Slack signature verification.
2. Stop routing restricted to eligible human events.
3. Pure allowlist + rich mention classification.
4. Durable pre-admission.
5. Adapter normalization and handoff.
6. Config/profile/runtime awaits.

Acceptance criteria:

- Trusted automation is durably pre-admitted before the first await.
- Preadmission and adapter derive identical channel/thread/event/actor identity.
- Slack retries deduplicate without duplicate responses.
- An untrusted bot with an exact mention is ignored.
- A trusted bot without an exact rich mention is ignored.
- A trusted bot cannot issue Stop against a human turn.
- A trusted bot cannot use mutation tools, start research, approve remote git, or create a PR.
- A later human button click remains a separate, normally authorized synthetic human turn.

#### Task 4.4 — Rich-trigger tests, metrics, and docs

Deliverables:

- Focused and production-path rich-trigger tests.
- Bounded observability events for admitted and rejected triggers.
- Updated operations, extension, port-ledger, and manifest commentary.

Dependencies: Tasks 4.1–4.3.

Minimum test matrix:

| Event | Expected result |
| --- | --- |
| Human `app_mention` | Existing behavior unchanged |
| Human thread reply | Existing behavior unchanged |
| OpenTag's own bot message | Ignored |
| Untrusted bot with attachment mention | Ignored |
| Trusted bot with top-level text only | Ignored by rich fallback; normal Slack `app_mention` behavior remains separate |
| Trusted bot with attachment pretext mention | One automation turn |
| Trusted app with Block Kit mention | One automation turn |
| Trusted bot with malformed blocks | Ignored safely |
| Trusted bot redelivery with same `event_id` | No duplicate turn/output |
| Trusted bot attempts Stop | Does not cancel |
| Trusted bot prompt requests a write | Write tools unavailable |
| Trusted bot in DM without rich mention | Ignored |

Metrics/logs:

- `trusted_rich_mention_admitted`
- `trusted_rich_mention_ignored` with bounded reason values: `not_allowlisted`, `missing_target_id`, `no_rich_mention`, `own_bot`, `invalid_config`, and `duplicate`.
- `runtime_default_selected` with source labels only.
- `permission_snapshot_generated` with actor kind and surface only.

Never log raw block/attachment text, secret refs, model prompt contents, or full Slack payloads.

Documentation updates:

- `docs/operations.md`: allowlist format, required bot user ID, fail-closed behavior, metrics, rollback.
- `docs/extending.md`: automation actor and safe-tool ceiling.
- `docs/centaur-port.md`: rich mention behavior and the stricter OpenTag authorization adaptation.
- `slack-app-manifest.yaml`: comment-only clarification if useful; no new scopes.

Acceptance criteria:

- Every row in the event matrix is covered by an automated test.
- Rejection logs contain only bounded reason/identity metadata.
- Documentation describes the feature as disabled until the allowlist and bot user ID are configured.
- No new Slack scope, deployment claim, or broad bot-message admission is introduced.

### Phase 5 — Integration, regression, and review

#### Task 5.1 — Cross-feature integration tests

Deliverable:

- A focused integration suite covering interactions among all three feature tracks.

Dependencies: Phases 1–4.

Required cases:

1. A human explicit `--opus` turn reports explicit runtime source and full channel tool access.
2. A human turn without flags uses a channel Claude default and fails visibly when the harness is disconnected.
3. A sticky human override continues to beat a changed channel default without rewriting sticky storage.
4. A trusted rich automation uses the channel runtime default but receives only the safe-tool intersection.
5. The automation permission snapshot contains no human attribution and no write tools.
6. A trusted automation cannot cancel, mutate, start research, or gain remote-git authorization.
7. A Slack retry remains exactly-once through pre-admission and render ownership.
8. Permission introspection during a Stop or replacement is suppressed by the active-turn fence.

Acceptance criteria:

- Tests exercise the production adapter/worker path where practical, not only isolated helpers.
- Existing human and slash-command behavior remains green.

#### Task 5.2 — Required validation

Deliverable:

- A complete validation-results table in `PROGRESS.md`, including unavailable-tool limitations.

Dependencies: Task 5.1.

Run from the repository after focused tests pass:

```bash
cd <opentag-repo>
pnpm check-types
pnpm test

cd <opentag-repo>/edge
npm run typecheck
npm test
npm run test:e2e

cd <opentag-repo>/edge/workers/sandbox
npm run typecheck

cd <opentag-repo>
git diff --check
```

If the container tool or Dockerfile changes, also run when Docker is available:

```bash
cd <opentag-repo>
docker build --platform linux/amd64 -f containers/harness/Dockerfile .
```

Acceptance criteria:

- Record every command, exit status, and test count in `PROGRESS.md`.
- Do not claim unavailable commands passed.
- A green source-only validator is not sufficient by itself.

#### Task 5.3 — Fresh adversarial review

Deliverable:

- A final review section in `implementation-report.md` or a linked review artifact with severity-ordered evidence.

Dependencies: Task 5.2.

The reviewer must inspect at least:

- authorization source versus displayed permission snapshot;
- secret and endpoint redaction;
- concurrency isolation of snapshot context;
- schema migration/idempotency;
- runtime precedence and sticky persistence;
- automation actor identity and human-attribution separation;
- trusted allowlist parsing and own-bot loop prevention;
- first-await pre-admission ordering;
- Stop eligibility and cancellation safety;
- retry/dedup behavior;
- tool ceiling and future-tool default denial;
- harness envelope validation and non-authoritative permission file;
- documentation truthfulness and activation gates.

Acceptance criteria:

- Findings are written in severity order with file/line evidence.
- All high/medium findings are fixed or explicitly left as blockers.
- Run affected focused tests again after fixes.
- Completion requires a fresh review after the final fix, not an earlier review of a superseded diff.

#### Task 5.4 — Final implementation report

Deliverable:

- `goal-outputs/centaur-gap-implementation/implementation-report.md`

Dependencies: Task 5.3.

Required contents:

- feature-by-feature source and test evidence;
- exact configuration and data-contract changes;
- validation table with actual results;
- adversarial review outcome;
- remaining limitations;
- external activation checklist;
- rollback plan;
- statement of whether any deploy, commit, push, PR, or external mutation occurred.

Acceptance criteria:

- The report links every implemented feature to source and test evidence.
- Validation counts match `PROGRESS.md`.
- Any remaining blocker or activation dependency is explicit.
- The report does not claim external activation, publication, or production proof that did not occur.

## 7. Expected file map

This is the intended ownership map. Equivalent narrowly scoped names are acceptable when the current implementation makes them clearer.

| Area | Expected files |
| --- | --- |
| Permission contracts | `edge/src/permissions/contract.ts`, `snapshot.ts`, `context.ts` |
| Access/config | `edge/src/config/access-bundle.ts`, `workspace-config-do.ts` |
| Tools | `edge/src/tools/index.ts`, `edge/src/tools/guard.ts` |
| Runtime resolution | `edge/src/store/thread-overrides.ts`, `edge/src/slack/overrides.ts`, `edge/src/agent-turn.ts`, `edge/src/bot-engine.ts`, `edge/src/commands/index.ts` |
| Request identity | `edge/src/request-context.ts` |
| Slack ingress | `edge/src/slack/rich-display-text.ts`, `ingress-normalize.ts`, `pre-admit-turn.ts`, `cloudflare-slack-adapter.ts` |
| Worker/config | `edge/src/env.ts`, `edge/src/worker.ts`, `edge/wrangler.bot.toml`, `slack-app-manifest.yaml` |
| Harness transport | `edge/src/harness/client.ts`, `edge/workers/sandbox/turn-contract.ts`, `edge/workers/sandbox/src/router.ts`, `edge/workers/sandbox/harness-server.ts` |
| Harness image | `containers/harness/Dockerfile` |
| Tests | Focused new tests plus existing product-spine, overrides, pre-admission, adapter, Stop, harness, and workerd suites |
| Docs | `docs/extending.md`, `docs/operations.md`, `docs/centaur-port.md`, `DECISIONS.md` if new invariants require locking |

## 8. Acceptance criteria by feature

### 8.1 Permission introspection

- Human, automation, and operator surfaces return bounded redacted snapshots.
- Allowed/denied tools reflect actual bundle, policy, and automation ceilings.
- Snapshot provenance matches actual runtime selection.
- Harness snapshot adds actual sandbox restrictions from the sandbox Worker.
- No authorization decision reads the snapshot or its container file.
- No secret value or sensitive URL component appears in output, logs, fixtures, or tests.

### 8.2 Channel runtime defaults

- Defaults are persisted per team/channel and survive DO restart.
- Existing DO data upgrades safely.
- Precedence is explicit > sticky > channel > deployment.
- Defaults never become sticky merely by use.
- Invalid configurations are rejected atomically.
- Selected unavailable runtimes fail visibly without fallback.
- `/config` and admin surfaces use the same validation.

### 8.3 Trusted rich mentions

- Only exact allowlisted bot/app IDs can use the fallback.
- Only exact rich-payload mentions of the configured OpenTag bot user trigger.
- Verification precedes classification; durable pre-admission precedes awaits.
- Automation actors are distinct from humans and read-only by default.
- Stop, writes, research, remote git, and PR creation remain unavailable.
- Redelivery remains exactly-once.
- Existing human ingress behavior is unchanged.

## 9. Rollout and activation gates

Source completion does not authorize activation. After implementation, an operator may separately approve:

1. Set `SLACK_BOT_USER_ID` to the installed OpenTag bot user ID.
2. Set `SLACK_TRUSTED_TRIGGER_ACTORS` to reviewed exact bot/app IDs.
3. Configure selected channel runtime defaults through admin config or `/config runtime set`.
4. Build and release the updated harness image if permission CLI support is desired.
5. Deploy the bot and harness Workers.
6. Run live Slack smoke tests in an approved test channel.

No Slack reinstall should be required because this feature set adds no scopes. Verify that assumption against the final diff before activation.

### Live smoke checklist after separate approval

- `/config runtime show/set/clear` in a test channel.
- Human no-flag turn uses channel default.
- Explicit flag overrides the channel default.
- `show_permissions` output is redacted and accurate.
- `opentag permissions` works during a harness turn.
- Allowlisted alert message with attachment-only mention triggers once.
- Unallowlisted equivalent does not trigger.
- Automation request cannot write or Stop.
- Duplicate delivery does not duplicate output.
- Clear status and final Slack response remain fenced and visible.

## 10. Rollback

- Trusted rich triggers: unset `SLACK_TRUSTED_TRIGGER_ACTORS`. The default is disabled.
- Channel runtime defaults: run `/config runtime clear` or clear the fields through authenticated admin config.
- Permission introspection: it is read-only; remove the tool/endpoint only through a subsequent code rollback. It must not be required for authorization, so disabling it cannot grant rights.
- Harness CLI: remove the image addition in a later approved release. Authorization remains in the outer Worker.
- DO columns/fields are additive. Rollback code must tolerate their presence and ignore them; do not destructively migrate them away during emergency rollback.

## 11. Completion definition

The goal is complete only when:

- every task ledger item is complete;
- focused, full edge, workerd, root, harness, and diff checks pass or unavailable checks are named;
- a final fresh adversarial review has no unresolved high/medium finding;
- documentation matches the implemented behavior;
- `PROGRESS.md` and `implementation-report.md` exist and agree;
- no external activation is falsely claimed;
- the final response links the durable artifacts and summarizes remaining activation work.
