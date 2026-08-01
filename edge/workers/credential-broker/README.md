# Credential broker

`opentag-credential-broker` is the last-mile boundary between OpenTag's
secret-free authorization metadata and an external credential-custody system.

The Worker:

1. authenticates only the internal `opentag-bot` service binding;
2. derives the canonical Slack tenant id and reads the versioned public
   credential reference from `PlatformStateDO`;
3. rejects revoked, expired, cross-tenant, provider-mismatched, and
   insufficient-scope references;
4. forwards only bounded metadata and immutable connector labels to an
   explicitly configured `CUSTODY` service binding; and
5. returns a short-lived bearer only in the response body, without persisting
   or logging it.

The custody binding is deliberately absent from the default Wrangler config.
The deployment is not provider-ready until an approved KMS, envelope, or
self-hosted custody Worker exists and is bound as `CUSTODY`. A missing custody
binding returns `credential_custody_unavailable`; it never fabricates success.

The bot caller must set the `CONNECTOR_CREDENTIAL_BROKER_TOKEN` secret and
send it through the `CONNECTOR_CREDENTIALS` service binding. Provider tokens,
OAuth codes, private keys, and raw secret values are prohibited from the
broker request, platform ledger, access bundles, and logs.

Dry-run the Worker with:

```bash
npx wrangler deploy --config workers/credential-broker/wrangler.toml --dry-run
```
