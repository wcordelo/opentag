# Connector authorization architecture

This is the shared security boundary for credentialed connectors such as Google
Drive, Linear, X, and future hosted MCP integrations. It is intentionally
separate from the Slack tool allowlist: a tool name is not a credential grant.

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
