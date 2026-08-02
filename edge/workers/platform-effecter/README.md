# Platform effecter

This Worker is the missing execution boundary between OpenTag's secret-free
`platform_effect_intents` ledger and future provisioning, custody, OAuth,
marketplace, billing, and memory providers.

`POST /run` requires `Authorization: Bearer $EFFECTOR_AUTH_TOKEN` and accepts
only an effect scope, intent id, worker id, and bounded lease duration. It
resolves the tenant/platform Durable Object, claims one intent, invokes an
explicitly registered adapter, and reports a bounded external receipt or a
safe retry/terminal failure through the lease owner.

The baseline Worker intentionally registers no provider adapters. A request
therefore ends as `effect_adapter_unconfigured`; it never claims success,
stores a provider token, runs an OAuth callback, charges billing, or deletes
memory. Adapter implementations must be added only after the custody, tenancy,
provider, and compliance decisions in the platform architecture document are
approved.

Every successful adapter invocation must return an opaque external receipt
reference. The runner will not mark an effect completed from an empty or
malformed adapter result; provider work that cannot produce a receipt is a
manual reconciliation failure, not a fabricated success.

The runner renews the Durable Object lease periodically while an adapter call
is in flight. If the state owner cannot record a failure or completion, the
request returns a retryable 503 rather than fabricating a receipt; the provider
adapter must therefore use the intent idempotency key for reconciliation.

An approved provider Worker can be connected through the optional
`PLATFORM_EFFECT_ADAPTER` service binding and
`PLATFORM_EFFECT_ADAPTER_AUTH_TOKEN` secret. When both are configured, every
effect kind is sent to `POST /execute` on that binding using this versioned,
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
claim that any external effect is live. The optional provider service binding
is intentionally absent from the default `wrangler.toml`.
