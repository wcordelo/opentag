# Identity custody adapter

`opentag-identity-custody` is the authenticated, provider-independent boundary
for the `identity_custody` platform effects. It accepts only tenant-scoped
identity references, public-key metadata, version, backend, operation, and an
idempotency key. Private keys, signing material, provider tokens, and OAuth
codes are rejected by the contract and never enter the Worker.

The Worker remains fail-closed until an independently authenticated
`IDENTITY_PROVIDER_ADAPTER` is configured. That adapter owns key generation,
signing, storage, rotation, and revocation in the approved custody system. The
Worker returns only a bounded external receipt and, for provisioning/rotation,
the public key needed by the platform ledger.

The boundary can be dry-run without creating a key store or a key:

```bash
npx wrangler deploy --config workers/identity-custody/wrangler.toml --dry-run
```

No provider adapter, key, or identity secret is configured by this Worker.
