# Billing adapter boundary

This Worker is the provider-independent boundary for one already-authorized
billing meter operation. The platform ledger remains the source of truth for
tenant provisioning, usage acceptance, plan entitlement, and effect leases.
The generic platform effect runner owns claiming and completing those leases;
this Worker does not duplicate that behavior.

`POST /meter` requires `Authorization: Bearer $BILLING_ADAPTER_AUTH_TOKEN` and
accepts only the versioned fields in
`edge/src/platform/billing-adapter-contract.ts`: tenant, intent/idempotency,
event/execution, metric quantity/unit/tier, plan ID/revision, amount in minor
units, currency, and timestamp. The fixed shape has no credentials, payment
method, provider body, prompt, query, or arbitrary metadata field.

The amount and currency are supplied by the approved billing authority. This
boundary validates and correlates them; it does not calculate prices, authorize
charges, or decide invoice/overage policy. `billingAdapterRequestFromIntent`
also requires the supplied plan revision to match the existing metadata-only
meter intent.

The Worker requires both its internal caller token and the optional
`BILLING_PROVIDER_ADAPTER` service binding plus its separate binding token. If
either binding or token is absent, `/meter` returns `503` and makes no provider
request. The provider adapter receives the same fixed request and must return a
strict receipt echoing every correlation field, including tenant, idempotency,
plan, amount, and currency. Mismatches or malformed responses fail closed.

Provider credentials stay in the separately deployed provider adapter. This
Worker logs only fixed error codes and never serializes request bodies,
provider responses, credentials, or exception messages.

The default configuration intentionally leaves the provider service binding
commented out. Validate the bundle without deploying it with:

```bash
wrangler deploy --dry-run --config wrangler.toml
```
