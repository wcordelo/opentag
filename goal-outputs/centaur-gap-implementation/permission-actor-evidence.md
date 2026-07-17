# Permission and actor evidence

## Implemented behavior

- `edge/src/request-context.ts` models Slack humans and trusted Slack
  automations as distinct actors. Compatibility requester IDs are derived from
  the actor, rather than treating a bot or app identifier as a Slack user.
- `edge/src/permissions/contract.ts` defines the bounded
  `PermissionSnapshotV1` contract, the automation-safe tool ceiling, and the
  64 KiB serialized-size ceiling.
- `edge/src/permissions/snapshot.ts` builds a deterministic, redacted snapshot
  from the actual access bundle and resolved runtime. Automation snapshots omit
  MCP endpoint metadata and secret references. URL metadata is reduced to
  HTTPS origin and path without userinfo, query, or fragment.
- `edge/src/permissions/context.ts` binds a snapshot to an invocation using a
  `WeakMap`; it is not stored in a shared global or used as an authorization
  input.
- `edge/src/tools/index.ts` exposes `show_permissions` only through an
  exact-active-turn fence. The tool reads the invocation-bound snapshot after
  the real tool policy has already been computed.
- `edge/src/worker.ts` exposes an authenticated, no-store
  `GET /admin/permissions` operator surface.
- `edge/workers/sandbox/turn-contract.ts` rejects malformed or expanded
  snapshots, including unknown nested fields, unsorted or duplicate arrays,
  actor/metadata mismatches, URL query material, and invalid sandbox policy.
- `edge/workers/sandbox/src/router.ts` appends authoritative sandbox
  restrictions after validating the edge projection. The snapshot remains
  informational; the egress policy does not consume it.
- `edge/workers/sandbox/harness-server.ts` materializes the per-execution
  snapshot with mode `0600`, and `containers/harness/Dockerfile` provides
  `opentag permissions` for reading that file.

## Actor safety

- Automation turns do not call `users.info`.
- Automation turns do not receive human attribution, human-only shortcuts,
  research routing, coding intent, remote-git approval, PR creation, or Stop
  authority.
- Tool availability is intersected with `AUTOMATION_SAFE_TOOLS`; the snapshot
  reports the resulting policy but cannot grant capabilities.

## Test evidence

- `edge/test/permission-snapshot.test.ts` covers deterministic redaction,
  bounded output, automation omissions, and invocation isolation.
- `edge/test/admin-permissions.test.ts` covers operator authentication,
  no-store responses, and redacted output.
- `edge/test/tool-execution-fence.test.ts` covers exact-turn fencing for the
  introspection tool.
- `edge/test/agent-turn-harness.test.ts`,
  `edge/test/harness-container-router.test.ts`, and
  `edge/test/harness-server.test.ts` cover projection, strict validation,
  sandbox augmentation, and private-file materialization.
- `edge/test/slack-agent-stop.integration.test.ts` proves on the signed
  production ingress path that a trusted automation receives only the safe
  tool intersection and no human-only authority.

## Validation result

The deterministic validator confirms that the only production consumers of
`requirePermissionSnapshot` are the permission context and the
`show_permissions` tool, and that the sandbox egress policy does not read the
snapshot.
