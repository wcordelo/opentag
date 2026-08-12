# Connector authorization architecture

Status: **source-complete authorization foundation; synthetic-live; provider
broker and external connector calls remain fail-closed**

Updated: **2026-08-01**

This is the shared security boundary for credentialed connectors such as Google
Drive, Linear, X, and future hosted MCP integrations. It is intentionally
separate from the Slack tool allowlist: a tool name is not a credential grant.
The current deployment matrix is in [current-state.md](./current-state.md).

## Contract

Every connector request is derived from the verified ingress context and carries
an immutable label set from `edge/src/connectors/authorization.ts`:

- workspace, project, and channel scope;
- requester and actor kind;
- execution and thread identity;
- connector and action;
- access-bundle id and monotonic revision;
- optional opaque credential reference and credential version;
- issue/expiry timestamps and a SHA-256 label digest.

Labels contain no token, key, OAuth code, or secret. A connector may receive the
credential material only through a separately controlled runtime injection path
after the reference has been resolved.

## Access bundles

`AccessBundle` remains the server-side tool policy. The additive
`connectorGrants` list makes credentialed access explicit:

```json
{
  "connectorId": "google_drive",
  "actions": ["search"],
  "scope": "project",
  "projectId": "P1",
  "credentialRef": "credential:google:workspace-drive"
}
```

Repository-backed grants add an exact `repoId`; Graphify tools reject a
project/workspace grant that is not bound to the requested repository before
calling the private service binding:

```json
{
  "connectorId": "code_graph",
  "actions": ["code_graph_search", "code_path", "code_impact"],
  "scope": "project",
  "projectId": "P1",
  "repoId": "repo-one"
}
```

Bundles have a monotonic revision and an `active`/`revoked` status. Legacy rows
without this metadata normalize to revision `1`, `active`. Updating a bundle
increments the revision; revocation increments it again and cannot be silently
undone. A request issued under an earlier revision is rejected at the effect
boundary.

## Credential references

The Worker stores only metadata such as provider, reference name, version,
scopes, subject, expiry, and revocation time. The reference is an opaque lookup
key; its secret value belongs to the approved credential injection system. A
revoked or expired reference cannot issue new labels and invalidates in-flight
work when revalidated.

## Revocation and race closure

1. Resolve the current channel configuration and bundle inside the workspace
   Durable Object.
2. Resolve the credential reference metadata from the same authoritative DO.
3. Issue short-lived immutable labels.
4. Perform the connector call using the label-derived scope.
5. Re-read the bundle and credential reference before accepting results or
   applying an external effect.

Any bundle revision change, credential revocation, expiry, grant change, scope
change, or label-digest mismatch fails closed. Connector results must not be
accepted merely because the initial authorization succeeded.

## Citation contract

Every connector result must retain stable source identity, content revision,
retrieval time, ACL policy reference, and (once issued) the authorization digest,
bundle revision, connector action, and credential version. Citations never carry
credential values. A later renderer may link or quote the citation, but it may
not manufacture missing provenance.

## Drive readiness gate

Google Drive is not enabled by this foundation alone. The Drive connector must
provide bounded search, source ACL/membership checks, deletion/revocation
handling, citations, rate/size/time limits, and tests that revalidate the labels
after retrieval. The implementation uses the optional `CONNECTOR_CREDENTIALS`
service binding for short-lived token resolution; until that broker and the
Google OAuth/custody flow are deployed, `search_drive` fails closed as
`knowledge_unavailable`. The first Drive grant must use this contract rather
than a connector-specific OAuth or permission shortcut.

## Guarded Linear writes

Linear MCP remains read-only. The edge `save_linear_issue` tool is the only
current mutation path and is available only when the channel access bundle
contains the tool and a `linear/create_issue` connector grant with an active
credential reference. The flow is:

1. `confirm_write` renders the exact title, description, team, assignee,
   project, and project-milestone fields.
2. A durable approval record is written only after the exact human click. It is
   bound to the Slack workspace/channel, requester, execution, thread, a
   normalized field digest, and a five-minute expiry. It contains no token.
3. `save_linear_issue` must present that approval ID and the exact same fields.
   The tool rejects missing, expired, cross-thread, automation, or mismatched
   approvals before resolving a credential.
4. The connector issues immutable `linear/create_issue` labels, resolves the
   opaque credential through `CONNECTOR_CREDENTIALS`, calls the bounded Linear
   GraphQL mutation, and revalidates the labels after the response. An
   ambiguous network failure retains the active-turn effect fence so a retry
   cannot silently create a duplicate issue.

The shared-fleet platform migration adds a separate `connector_effect`
envelope for this operation. It carries the approval/request reference and
digests rather than the draft or credential, so a tenant-scoped provider
adapter can own execution and return a durable external receipt. The current
tool has not been switched to that adapter: until the adapter, custody mapping,
and reconciliation store are configured, the path remains fail-closed and no
live Linear mutation is claimed.

The current Slack ingress uses the stable connector-project slot `workspace`
because it does not yet have a separate internal project directory. Linear's
own `project` and `milestone` values remain exact user-approved selectors and
are resolved to Linear IDs inside the connector. Enabling the path still
requires the credential broker, Linear OAuth/custody provisioning, an active
access-bundle grant, and a live validation against a non-production test
workspace; this branch does not perform that external validation.

## Current live boundary

The deployed bot does not have a `CONNECTOR_CREDENTIALS` service binding. The
synthetic platform run proved that opaque references, bundle revisions,
OAuth-grant metadata, revocation, citation fields, and effect intents can be
stored and revalidated without secret material. It did not prove Google or
Linear provider access. Drive search and Linear create therefore remain
fail-closed until the separately deployed broker, provider custody, grants,
allowlists, and a test workspace are all present.

Cloudflare Worker Secrets are the approved deployment/bootstrap configuration
path, including one-click and Wrangler CLI setup. They are not a per-tenant
credential store for a shared Worker fleet; the broker must preserve tenant
scope, rotation, revocation, and audit.
