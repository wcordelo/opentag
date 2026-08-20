# Platform effecter

This Worker is the missing execution boundary between OpenTag's secret-free
`platform_effect_intents` ledger and future provisioning, custody, OAuth,
marketplace, billing, and memory providers.

`POST /run` requires `Authorization: Bearer $EFFECTOR_AUTH_TOKEN` and accepts
only an effect scope, intent id, worker id, and bounded lease duration. It
resolves the tenant/platform Durable Object, claims one intent, invokes an
explicitly registered adapter, and reports a bounded external receipt or a
safe retry/terminal failure through the lease owner.

The default Worker remains fail-closed for every effect except the explicitly
reviewed `connector_effect` path. The current deployment registers the
private Linear provider adapter only for `connector_effect`; provisioning,
identity, credential-custody, OAuth, marketplace, billing, memory, and unknown
effect kinds still end as `effect_adapter_unconfigured`. The bot's
`PLATFORM_PROVIDER_EFFECTS_MODE` remains `disabled` until the controlled
workspace and custody mapping are ready.

Every successful adapter invocation must return an opaque external receipt
reference. The runner will not mark an effect completed from an empty or
malformed adapter result; provider work that cannot produce a receipt is a
manual reconciliation failure, not a fabricated success.

The runner renews the Durable Object lease periodically while an adapter call
is in flight. If the state owner cannot record a failure or completion, the
request returns a retryable 503 rather than fabricating a receipt; the provider
adapter must therefore use the intent idempotency key for reconciliation.

An approved provider Worker is connected through the
`PLATFORM_EFFECT_ADAPTER` service binding and
`PLATFORM_EFFECT_ADAPTER_AUTH_TOKEN` secret. When both are configured, only
`connector_effect` is sent to `POST /execute` on that binding using this versioned,
metadata-only envelope:

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
