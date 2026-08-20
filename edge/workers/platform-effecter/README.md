# Platform effecter

This Worker is the missing execution boundary between OpenTag's secret-free
`platform_effect_intents` ledger and future provisioning, custody, OAuth,
marketplace, billing, and memory providers.

`POST /run` requires `Authorization: Bearer $EFFECTOR_AUTH_TOKEN` and accepts
only an effect scope, intent id, worker id, and bounded lease duration. It
resolves the tenant/platform Durable Object, claims one intent, invokes an
explicitly registered adapter, and reports a bounded external receipt or a
safe retry/terminal failure through the lease owner.

The default Worker remains fail-closed until a provider adapter is explicitly
configured. Each effect family has its own least-privilege service binding and
bearer secret; provisioning, identity, credential custody, connector OAuth,
marketplace, billing, memory deletion, and connector effects cannot share an
adapter boundary. An adapter is registered only when both its binding and
secret are present, and it receives only its matching effect kind.

Every successful adapter invocation must return an opaque external receipt
reference. The runner will not mark an effect completed from an empty or
malformed adapter result; provider work that cannot produce a receipt is a
manual reconciliation failure, not a fabricated success.

The runner renews the Durable Object lease periodically while an adapter call
is in flight. If the state owner cannot record a failure or completion, the
request returns a retryable 503 rather than fabricating a receipt; the provider
adapter must therefore use the intent idempotency key for reconciliation.

An approved provider Worker can be connected for one effect family through its
dedicated service binding and bearer secret. The supported pairs are
`PROVISIONING_EFFECT_ADAPTER`/
`PROVISIONING_EFFECT_ADAPTER_AUTH_TOKEN`,
`IDENTITY_CUSTODY_EFFECT_ADAPTER`/
`IDENTITY_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN`,
`CREDENTIAL_CUSTODY_EFFECT_ADAPTER`/
`CREDENTIAL_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN`,
`CONNECTOR_OAUTH_EFFECT_ADAPTER`/
`CONNECTOR_OAUTH_EFFECT_ADAPTER_AUTH_TOKEN`,
`MARKETPLACE_EFFECT_ADAPTER`/
`MARKETPLACE_EFFECT_ADAPTER_AUTH_TOKEN`,
`BILLING_METER_EFFECT_ADAPTER`/
`BILLING_METER_EFFECT_ADAPTER_AUTH_TOKEN`, and
`MEMORY_DELETION_EFFECT_ADAPTER`/
`MEMORY_DELETION_EFFECT_ADAPTER_AUTH_TOKEN`.

The connector effect boundary uses the dedicated
`CONNECTOR_EFFECT_ADAPTER`/`CONNECTOR_EFFECT_ADAPTER_AUTH_TOKEN` pair.

The Worker registers an adapter only when both members of a pair are present.
An adapter receives only its matching effect kind; a credential adapter cannot
receive provisioning or billing intents. The `/health` response exposes the
configured kind list and non-secret missing-binding/missing-auth states.
Every adapter uses this versioned, metadata-only envelope:

```json
{
  "schemaVersion": 1,
  "intent": {
    "schemaVersion": 1,
    "intentId": "...",
    "idempotencyKey": "...",
    "scope": "tenant",
    "tenantId": "...",
    "kind": "credential_custody",
    "targetRef": "...",
    "metadata": { "operation": "rotate", "provider": "...", "version": 2 },
    "requestedAt": "..."
  }
}
```

For `kind = "connector_effect"`, the metadata is restricted to
`connectorId`, `action`, `credentialRef`, `credentialVersion`,
`authorizationDigest`, `requestRef`, `requestRevision`, and `requestDigest`.
The deployed adapter currently supports only `linear/create_issue`; Google
Drive remains unsupported and fail-closed.
`requestRef` is an opaque durable reference such as a Linear approval record;
it is not a query, prompt, document body, or credential. A provider adapter
must resolve that reference inside its tenant boundary, revalidate the grant
and custody metadata, use the intent idempotency key, and return an opaque
external receipt. The adapter is deployed, but it does not enable provider
effects by itself: custody credentials, a controlled Linear workspace subject,
a grant, and `PLATFORM_PROVIDER_EFFECTS_MODE=linear` are still required.

The provider must return either
`{"schemaVersion":1,"status":"completed","externalReceiptRef":"..."}`
or a strict failure envelope with `errorCode`, `retryable`, and optional
`retryAfterSeconds`. Extra fields, malformed receipts, and unsupported schema
versions fail closed. Provider credentials, leases, and internal state never
cross this service-binding boundary.

The bot publishes metadata-only wakeups to `opentag-platform-effects` after
state mutations. This Worker consumes those wakeups through the authenticated
`/run` boundary and schedules retryable failures from the bounded receipt
timestamp. A wakeup contains only an internal `PlatformStateDO` object name;
the intent metadata is read from the DO, so provider payloads and secrets do
not enter the queue.

The Durable Object binding uses `script_name = "opentag-bot"`, so this Worker
does not create a second platform-state database. Deploying it also requires
the `EFFECTOR_AUTH_TOKEN` secret and a deliberate decision to make a provider
adapter available; this baseline is safe to validate locally but is not a
claim that any external effect is live. The provider service binding is
present in the deployment configuration. The adapter, request resolver, and
idempotency Durable Object service are private Workers; the custody mapping
remains intentionally unconfigured until the controlled test credential is
provisioned.
