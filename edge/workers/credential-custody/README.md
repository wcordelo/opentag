# Credential custody adapter

`opentag-credential-custody` is the optional Cloudflare-native last-mile
adapter for the credential broker. It keeps provider tokens out of
Durable Objects, queues, access bundles, Wrangler vars, and logs:

1. the broker authenticates the service binding with `CUSTODY_AUTH_TOKEN`;
2. the custody Worker validates the tenant, immutable connector labels,
   credential reference, version, and active status;
3. `CUSTODY_BINDINGS_JSON` selects a named Secrets Store binding using only
   `{ref, version, binding, expiresAt}` metadata;
4. the Secrets Store binding is read once; and
5. the short-lived bearer is returned with `cache-control: no-store`.

The default config has no Secrets Store binding map and therefore returns a
configuration error. This change does not create a store, upload a secret, or
choose a production custody policy. An operator must approve the store,
secret rotation/expiry policy, and non-production smoke test before enabling
the adapter.

Dry-run the Worker with:

```bash
npx wrangler deploy --config workers/credential-custody/wrangler.toml --dry-run
```
