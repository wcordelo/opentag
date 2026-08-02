# Memory deletion executor boundary

This Worker is the provider-independent boundary for one source-scoped memory
deletion at a time. The platform Durable Object remains the source of truth for
the deletion request, deletion epoch, receipt ledger, and terminal status.

`POST /delete` accepts only:

- the tenant and deletion request identifiers;
- one bounded `sourceKey`;
- the deletion epoch and request timestamp; and
- the fixed `delete` operation.

It does not accept memory contents, search text, prompts, provider credentials,
or a generic metadata payload. It requires `MEMORY_DELETION_AUTH_TOKEN` for the
internal caller and a separately authenticated `MEMORY_PROVIDER_ADAPTER`
binding. The adapter must return the existing source-scoped receipt contract;
the Worker verifies every request/receipt identity and requires an opaque
receipt reference for `deleted` and `not_found` outcomes.

The Worker is intentionally fail-closed when either binding is absent. It does
not claim a deletion, call a provider directly, or write the platform ledger.
An approved effect runner must submit the validated receipt through the
platform state's `/memory/deletion/receipt` path after the provider call.

## Activation gates

Before adding the service binding or secrets, choose and document:

1. the memory provider and its source-by-source deletion API;
2. retention, legal-hold, and eventual-consistency guarantees;
3. tenant isolation and provider credential custody;
4. retry/idempotency behavior for `deleted`, `not_found`, and `failed`; and
5. a non-production test namespace and a reversible smoke test.

`wrangler deploy --dry-run --config wrangler.toml` validates the bundle without
activating a provider. Do not treat Worker health or a successful adapter call
as proof that the platform ledger recorded a receipt.
