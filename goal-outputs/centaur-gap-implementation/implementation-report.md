# OpenTag Centaur-gap implementation report

## Outcome

OpenTag now implements the three portable capabilities selected from the
Centaur gap review:

1. bounded, redacted permission introspection for human, automation, operator,
   and harness contexts;
2. per-channel model and harness defaults with explicit provenance and
   deterministic precedence; and
3. fail-closed Slack admission for exact allowlisted bot/app actors that visibly
   mention the configured OpenTag bot user in a bounded rich payload.

The implementation was completed in the existing working tree at starting
commit `660f586c4d284cda6e8db511f6e2d78ca5b818a2`. The authoritative specification
remained unchanged with SHA-256
`5ebb36d85bd675eb5741e405131a571303107b092c4166aa55a716a4214fbdfa`.

The work deliberately preserves OpenTag's existing architecture:

- Slack Events API remains the ingress.
- Conversation and execution Durable Objects remain authoritative for
  deduplication, admission, Stop, effects, render obligations, and recovery.
- The access bundle, tool policy, actor type, and runtime selection remain the
  authorization inputs.
- The permission snapshot is derived output. It cannot expand authority.
- The harness receives a validated projection and adds factual sandbox
  restrictions, but it is not an authorization decision point.
- Unsupported or disconnected runtime selections fail visibly rather than
  silently falling back.

No remote environment, Cloudflare deployment, Slack installation, repository
publication, or pull-request workflow was performed. Those actions require a
separate operator decision after reviewing the activation checklist below.

The working tree also contained concurrent, unrelated OpenTag remediation work
owned by another task. This goal did not revert that work. During combined-tree
validation, a small number of shared recovery tests and source expectations
changed concurrently; the final implementation was validated against the
current combined tree. The feature-specific evidence is isolated in the three
evidence documents beside this report.

## Permission introspection

### Actor model

`edge/src/request-context.ts` now represents a requester as an explicit actor:

- `slack_user` for a human Slack user; and
- `slack_automation` for an admitted bot/app actor.

This avoids the dangerous compatibility pattern of treating a bot identifier as
if it were a human Slack user. A compatibility requester ID can still be
derived where older interfaces require a string, but policy decisions retain
the actor kind.

Actor identity is propagated through pre-admission, normalization, the Slack
adapter, bot-engine selection, agent-turn execution, permission reporting, and
the harness request. Automation turns skip `users.info` because there is no
human profile to resolve. They also omit `Prompted by:` attribution, cannot
take the human Stop path, and do not receive human-only research, memory,
trivial-reaction, coding, remote-git, or PR behavior.

### Snapshot contract

`edge/src/permissions/contract.ts` defines `PermissionSnapshotV1`. The contract
is intentionally descriptive and bounded. It includes:

- actor kind and redacted identity metadata;
- actual allowed and denied tool names after policy resolution;
- channel policy booleans;
- runtime value and per-field provenance;
- redacted connector metadata;
- redacted secret-reference names for authorized human/operator views;
- sandbox restrictions added by the sandbox Worker; and
- metadata-visibility flags that state which fields may be present.

The serialized snapshot is capped at 64 KiB. Arrays are sorted, deduplicated,
and bounded to produce stable output and prevent configuration amplification.
The automation-safe tool ceiling is expressed once as
`AUTOMATION_SAFE_TOOLS`; the actual automation tool set is the intersection of
the normal access policy and that ceiling.

### Redaction

`edge/src/permissions/snapshot.ts` strips sensitive URL material. Connector
endpoints are reduced to supported HTTPS origin and path metadata. Userinfo,
query strings, fragments, credentials, authorization headers, bearer values,
raw Slack events, and secret values are not emitted.

Automation views are more restrictive than human/operator views:

- MCP endpoint metadata is empty.
- Secret-reference metadata is empty.
- The actor is represented as automation rather than a human requester.

Human and operator views may include bounded secret reference identifiers, not
secret values. This distinction allows an operator to understand which named
credential bindings influence a turn without exposing the credential.

### Invocation isolation and tool surface

`edge/src/permissions/context.ts` uses a `WeakMap` keyed by the actual invocation
thread object. `bindPermissionSnapshot` binds the snapshot for the invocation;
`requirePermissionSnapshot` retrieves only that binding. A module-global
"current permissions" value is never used, so overlapping turns cannot read
one another's snapshots.

`show_permissions` in `edge/src/tools/index.ts` is available as a reserved
introspection tool. It first verifies the exact active turn through the existing
execution fence, then reads the invocation-bound snapshot. The tool does not
decide whether another tool may execute and does not update access state.

The deterministic validator searches production TypeScript for consumers of
`requirePermissionSnapshot`. Only the context module and the display tool are
allowed. It also verifies that the sandbox egress policy does not read the
snapshot.

### Operator and harness surfaces

`edge/src/worker.ts` exposes `GET /admin/permissions` behind existing admin
authentication. Responses set `Cache-Control: no-store`. The endpoint generates
the same bounded contract used by other surfaces rather than inventing an
operator-only schema.

The edge sends a permission projection with an authoritative harness turn.
`edge/workers/sandbox/turn-contract.ts` performs exact-shape validation:

- unknown top-level and nested keys are rejected;
- sorted/unique/bounded arrays are required;
- metadata visibility must match actor kind;
- automation MCP and secret lists must be empty;
- redacted endpoint paths cannot contain query or fragment material;
- sandbox values and booleans must have exact allowed types; and
- runtime identifiers and provenance are constrained.

After validation, `edge/workers/sandbox/src/router.ts` appends facts known only
to the authenticated sandbox Worker, such as repository-host allowlisting,
credential exposure mode, network restrictions, and whether remote git was
actually approved. The outer Worker remains the source for those facts.

`edge/workers/sandbox/harness-server.ts` writes the final per-execution snapshot
to a private file with mode `0600`. The harness image adds
`opentag permissions`, which reads the path supplied through
`OPENTAG_PERMISSIONS_FILE`. The file is execution-scoped and informational; it
is not consulted by egress, tool execution, repository mutation, or other
authorization code.

Detailed evidence is in `permission-actor-evidence.md`.

## Channel runtime defaults

### Persistence and migration

`edge/src/config/access-bundle.ts` defines `ChannelRuntimeDefaults` and the
shared normalizer. A default can select a harness, a model, or both subject to
the supported combination rules. A channel model requires the Claude Code
harness, preventing a configuration that cannot be executed.

`edge/src/config/workspace-config-do.ts` upgrades the existing `channel_config`
table additively. It checks `PRAGMA table_info(channel_config)` and adds
`default_harness_type` and `default_model` only when missing. This makes the
migration idempotent and preserves existing rows. Defaults are stored in the
WorkspaceConfig Durable Object, so they survive isolate and process restarts.

Updates normalize the complete candidate configuration before persistence.
Invalid combinations are rejected without partially changing one field.

### Precedence

`edge/src/store/thread-overrides.ts` resolves the model and harness independently
using this order:

1. explicit message selection;
2. sticky thread selection;
3. channel default; and
4. deployment default.

Each selected value carries its source: `explicit`, `sticky`, `channel`, or
`deployment`. Independent resolution matters because, for example, an explicit
harness selection can coexist with a model inherited from a sticky or channel
setting when the resulting pair is valid.

Using a channel default does not write it into thread overrides. A selection
becomes sticky only through the existing explicit persistence path. This keeps
channel policy separate from a user's deliberate thread preference.

### Configuration surfaces

`edge/src/commands/index.ts` provides:

- `/config runtime show`
- `/config runtime set --harness claude-code`
- `/config runtime set --harness claude-code --model <model>`
- `/config runtime clear`

The command reports effective stored channel defaults and validation errors.
Automation actors cannot change channel configuration. The admin mutation path
uses the same `normalizeChannelRuntimeDefaults` function, giving the Slack and
operator surfaces validation parity.

`edge/src/agent-turn.ts` passes the resolved harness, model, and provenance to
both the authoritative harness request and the permission snapshot. Runtime
selection metrics therefore describe the selection actually used by the turn.

If the chosen harness binding is unavailable, OpenTag reports a visible
authoritative-turn failure. It does not send the turn to AG-UI or another
harness as an implicit substitute. This preserves operator intent and makes
misconfiguration observable.

Detailed evidence is in `runtime-defaults-evidence.md`.

## Trusted rich-payload mentions

### Configuration and readiness

The feature uses exact Slack identifiers configured through:

- `SLACK_TRUSTED_TRIGGER_ACTORS`, containing allowlisted bot/app IDs; and
- `SLACK_BOT_USER_ID`, containing the exact OpenTag bot user ID that must appear
  as a visible rich mention.

`edge/src/slack/trusted-trigger.ts` parses the allowlist into exact bot/app
identities. Invalid tokens are ignored within a bounded parser and reported as
configuration diagnostics. A configured allowlist with no valid identifiers,
or an allowlist without a target bot user ID, is not considered ready.

Health/readiness includes this state. Invalid trusted-trigger configuration,
including `missing_target_id`, produces an unhealthy response rather than
quietly enabling a broad fallback.

### Visible-field parser

`edge/src/slack/rich-display-text.ts` walks only supported display-bearing
fields. It understands Slack nested rich-text structures and exact `user`
elements, plus bounded attachment text and attachment field values. It excludes
hidden callback metadata and Block Kit action `value` fields, so an invisible
identifier cannot trigger the bot.

Traversal is bounded by a 24,000-character display-text ceiling, bounded node
counts/depth, and a `WeakSet` for cycle detection. It does not stringify the raw
event. This reduces denial-of-service and accidental-data-exposure risk.

The classifier requires all of the following:

- configuration is ready;
- the event has an exact allowlisted `bot_id` or `app_id`;
- the event is not from OpenTag's own bot;
- a supported visible rich field contains an exact mention of
  `SLACK_BOT_USER_ID`; and
- the normal Slack signature verification has already succeeded.

Plain text that merely resembles an ID, hidden metadata, substring matches, and
untrusted bot/app actors do not qualify.

### Durable admission ordering

The worker performs signature verification, Stop extraction, and pure
trusted-trigger classification before durable admission. For an accepted turn,
`edge/src/slack/pre-admit-turn.ts` registers the execution and render obligation
before any profile, channel-configuration, Slack Web API, file download, or
runtime await.

The admitted actor is carried into `edge/src/slack/ingress-normalize.ts` and the
Slack adapter. The adapter only resolves a profile for `slack_user`, so a
trusted automation never calls `users.info`.

The existing durable event identity makes redelivery idempotent. An exact Slack
retry sees the existing admitted execution and does not produce a second
harness turn. Stable render client-message IDs also allow ambiguous Slack
responses to be replayed and reconciled through Slack's duplicate response
without producing a second user-visible message.

### Capability ceiling

Trusted triggering grants admission, not human authority. `edge/src/bot-engine.ts`
intersects the normal tool set with `AUTOMATION_SAFE_TOOLS`. Automation turns
cannot:

- use human-only mutation tools;
- start research;
- write memory;
- infer repository coding intent;
- approve remote git;
- create a pull request;
- route Stop; or
- produce human attribution.

The signed production-path integration test proves these restrictions together
with channel runtime selection and redelivery deduplication.

Detailed evidence is in `trusted-rich-trigger-evidence.md`.

## Validation results

The final local validation results are:

| Command | Result |
|---|---|
| `pnpm check-types` | Passed, exit 0 |
| `pnpm test` | Passed: 9 files, 34 tests |
| `cd edge && npm run typecheck` | Passed, exit 0 |
| `cd edge && npm test` | Passed: 53 files, 668 tests |
| `cd edge && npm run test:e2e` | Passed: 1 workerd file, 25 tests |
| `cd edge/workers/sandbox && npm run typecheck` | Passed, exit 0 |
| `git diff --check` | Passed with no whitespace errors |
| `python3 goal-outputs/centaur-gap-implementation/validate.py --source-only` | Passed all three source/test/doc tracks |
| Conflict-marker scan using `find` and `grep` | Passed; no merge markers found outside dependency/build directories |

Focused validation also passed during implementation:

- permission, runtime, trusted-trigger, harness, Stop, and integration suites
  passed as a 270-test set;
- strict permission transport hardening passed a 193-test focused set;
- the signed Slack integration passed all six scenarios;
- the final recovery-focused set passed 67 tests.

Docker is not installed in the current environment (`docker: unavailable`), so
the harness container image could not be built locally. The Dockerfile,
harness-server TypeScript, sandbox Worker, transport validator, and CLI behavior
were covered by typechecking and unit/integration tests, but an actual image
build remains an activation-stage validation item.

The Homebrew `rg` binary is also unusable in this environment because its
`libpcre2` dynamic library cannot be loaded. Conflict-marker validation was
therefore repeated with `find`, `xargs`, and `grep`; this is a tooling
limitation, not a product limitation.

## Adversarial review

A fresh read-only adversarial review ran after implementation and full
validation. It used the current working-tree diff, the authoritative spec, Opus,
and xhigh effort. The review was explicitly scoped to:

- authorization inputs versus the permission snapshot;
- exact redaction and snapshot shape;
- WeakMap invocation isolation;
- runtime precedence, persistence, and migration;
- visible-only rich mention parsing;
- readiness;
- first-await durable pre-admission;
- automation denial for Stop, writes, research, remote git, and PRs;
- exactly-once redelivery; and
- the harness as non-authoritative transport.

Final verdict: **approve**.

The reviewer reported no critical, high, medium, or blocking findings. It
explored several possible concerns and resolved them from source:

- multiple bounded retries do not imply duplicate execution because stable
  identity and durable fences remain authoritative;
- bot/app payloads are rejected before Stop routing;
- runtime provenance is retained per selected field;
- automation file turns still inherit the actor and safe-tool restrictions;
- the permission snapshot has no authorization consumer; and
- the harness validates and augments the projection without granting authority.

The raw final result and dispositions are preserved in
`adversarial-review.md`.

## External activation checklist

These are operator actions for a separately authorized activation:

1. Confirm the target Slack workspace and the intended OpenTag bot user ID.
2. Identify the exact producer `bot_id` and/or `app_id` values to allow. Do not
   use display names, substrings, wildcard IDs, or workspace-wide trust.
3. Set `SLACK_TRUSTED_TRIGGER_ACTORS` to only those exact identifiers.
4. Set `SLACK_BOT_USER_ID` to the exact OpenTag bot user ID.
5. Confirm `/health` reports trusted-trigger readiness and no invalid tokens.
6. Confirm the selected channel harness/model is supported by the deployed
   bindings before setting a channel default.
7. Exercise `/config runtime show`, then set the default in one test channel.
8. Send one signed real Slack event from an allowlisted producer with a visible
   rich mention; verify one durable execution and one final message.
9. Redeliver the exact Slack event and verify no second execution or message.
10. Send near-miss events: untrusted actor, hidden action value, wrong bot user
    ID, own-bot event, plain-text ID, and missing rich mention. Verify rejection.
11. Use `show_permissions`, `GET /admin/permissions`, and
    `opentag permissions` to confirm redaction and runtime provenance in the
    activated environment.
12. Build the harness container with the deployment's supported image builder,
    since Docker was unavailable during this local run.
13. Review metrics for admitted, rejected, duplicate, readiness, permission
    snapshot, and selected-runtime outcomes.
14. Expand the allowlist or channel defaults only after the single-channel
    smoke path is proven.

The existing Slack manifest requires no new OAuth scope for these capabilities.
Any app reinstall or environment mutation should still be treated as an
explicit operational action with its own review.

## Rollback

Rollback is configuration-first:

1. Remove or empty `SLACK_TRUSTED_TRIGGER_ACTORS` to disable trusted automation
   admission.
2. Clear channel runtime defaults with `/config runtime clear` or the
   authenticated admin equivalent. Threads then resolve from sticky or
   deployment defaults according to existing precedence.
3. Leave permission introspection disabled at the workflow/tool-policy layer if
   an operator does not want agents to call `show_permissions`; the operator
   endpoint remains admin-authenticated and no-store.

If a code rollback is required:

- remove the trusted-trigger classifier and parser wiring while preserving
  normal human Slack ingress;
- remove channel default reads while leaving the additive database columns in
  place, because additive unused columns are safer than destructive migration;
- stop sending the permission projection to the harness, then remove the CLI
  and snapshot surfaces; and
- retain the explicit actor model if possible, because it closes independent
  human/automation confusion risks.

Do not destructively drop Durable Object columns as an emergency rollback.
Clearing values and ignoring the additive columns preserves compatibility with
existing stored data and allows forward recovery.

After any rollback, rerun the same root, edge, workerd, sandbox, diff, and
deterministic validation commands. For trusted-trigger rollback, also prove
that normal human app mentions still enter through the existing path and that
bot/app events no longer qualify.

## Remaining limitations

- No live Slack workspace smoke test was performed. Signed integration tests
  cover the production worker path locally, but real Slack delivery,
  organization policy, installed app state, and real producer identifiers
  require an authorized activation.
- No Cloudflare Worker or Durable Object deployment was performed.
- No harness image build was performed because Docker is unavailable.
- No repository commit, push, branch creation, or pull request was performed.
- The trusted allowlist is static deployment configuration. Operators must
  maintain exact IDs when Slack applications change.
- Permission output is intentionally redacted and bounded; it is not a complete
  dump of deployment configuration and must not be used for forensic recovery
  of hidden values.
- The snapshot describes policy at turn construction time. Existing
  authoritative execution and tool fences remain necessary if policy changes
  during a turn.
- Channel defaults require the selected harness/model to exist in the deployed
  environment. The system exposes unsupported selection as an error rather
  than providing automatic substitution.
- The working tree contains concurrent remediation changes outside these three
  tracks. The full suite passed on the combined state, but publication should
  separate or intentionally group those changes according to the repository
  owner's chosen release plan.

With those activation-stage limitations made explicit, the source, tests,
documentation, deterministic validator, and independent review satisfy the
implementation specification.
