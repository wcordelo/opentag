# Provisioning adapter boundary

This Worker is the provider-independent boundary for one tenant-provisioning
step at a time. The platform Durable Object remains the source of truth for
tenant status, required steps, and receipt-bound activation.

`POST /provision-step` accepts only the external Slack tenant identifier,
request/idempotency identifiers, the selected isolation and custody modes, one
allowlisted provisioning step, the external requester subject, and a timestamp.
It does not accept credentials, OAuth codes, prompts, arbitrary resource
payloads, or a generic metadata object.

The Worker requires `PROVISIONING_ADAPTER_AUTH_TOKEN` for the internal caller
and a separately authenticated `PROVISIONING_PROVIDER_ADAPTER` binding. The
provider adapter returns the existing `ProvisioningStepReceipt` contract; the
Worker validates the receipt's step and idempotency key before returning it.

The boundary is intentionally fail-closed when either binding is absent. It
does not create Durable Objects, install Slack apps, mint identities, or mark a
tenant active. An approved effect runner must submit the validated receipt to
the platform state's provisioning-step route.

## Activation gates

Before configuring the service binding or secrets, choose and document:

1. the tenant locator and isolation authority;
2. idempotent resource creation and rollback for every required step;
3. Slack OAuth installation and identity/key custody ownership;
4. default access-bundle creation and revocation behavior; and
5. a non-production tenant namespace and reversible smoke test.

`wrangler deploy --dry-run --config wrangler.toml` validates the bundle without
creating provider resources.
