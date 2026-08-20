# Platform provider adapter

This is a non-production Linear `create_issue` adapter for the existing
secret-free platform effect envelope. `POST /execute` accepts only the
versioned `{ schemaVersion, intent }` envelope emitted by
`platform-effecter`. The only provider request data is obtained by resolving
the opaque `linear-write-approval:<id>` request reference inside the adapter.

The adapter requires an internal caller bearer,
`PROVIDER_REQUEST_RESOLVER` plus its bearer, `CREDENTIAL_BROKER` plus its
bearer, `PROVIDER_IDEMPOTENCY_STORE`, and
`LINEAR_CONTROLLED_WORKSPACE_SUBJECT`. It never accepts a provider token in
the effect envelope or request-resolution input. The broker is the only path
to a short-lived token; the broker must continue through credential custody.
The token is held only while the Linear GraphQL call is in flight and is not
included in receipts, errors, logs, or response bodies.

The request resolver response is an internal, metadata-plus-approval record:
`schemaVersion`, `requestRef`, `requestRevision`, `requestDigest`,
`authorizationDigest`, immutable connector `labels`, a public credential
reference, and the approved Linear write record. The adapter checks the
approval digest, label digest, tenant, action, controlled provider subject,
credential version, grant expiry, and Linear write scope before resolving the
credential.

`PROVIDER_IDEMPOTENCY_STORE` must implement atomic `POST /reserve`,
`/complete`, `/ambiguous`, and `/release` operations. Its records are strict
tenant/provider/action/idempotency receipts. A completed duplicate returns the
same opaque receipt without resolving the request or calling Linear. An
ambiguous provider result is durably recorded and never retried blindly.

The request-resolver and provider-idempotency bindings are deployed as
private Workers, and the effecter is wired to this adapter for
`connector_effect`. The controlled Linear workspace subject and custody
binding are intentionally still absent, so the adapter remains fail-closed in
production. The bot also keeps `PLATFORM_PROVIDER_EFFECTS_MODE=disabled`
until those operator-owned prerequisites and the live canaries are complete.

The adapter health endpoint also probes credential-broker readiness. Binding
presence alone never reports `providerEffectsEnabled`; custody must report
`providerResolutionEnabled` before the Linear action is advertised.
