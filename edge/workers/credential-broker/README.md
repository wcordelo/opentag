# Credential broker

`opentag-credential-broker` is the last-mile boundary between OpenTag's
secret-free authorization metadata and an external credential-custody system.

The Worker:

1. authenticates only the internal `opentag-bot` service binding;
2. revalidates the immutable labels against the authoritative
   `WorkspaceConfigDO` access bundle and connector grant;
3. derives the canonical Slack tenant id and reads the versioned public
   credential reference from `PlatformStateDO`;
4. rejects revoked, expired, cross-tenant, provider-mismatched, and
   insufficient-scope references;
5. forwards only bounded metadata and immutable connector labels to an
   explicitly configured `CUSTODY` service binding; and
6. returns a short-lived bearer only in the response body, without persisting
   or logging it.

The custody binding points at the separately deployable
`opentag-credential-custody` Worker, which is itself fail-closed until an
approved Secrets Store mapping or another reviewed custody implementation is
configured. The broker and custody Worker use separate internal service
tokens. A missing binding or custody auth returns an explicit
`credential_custody_unavailable`/`credential_custody_auth_unconfigured`; it
never fabricates success.

The bot caller must set the `CONNECTOR_CREDENTIAL_BROKER_TOKEN` secret and
send it through the `CONNECTOR_CREDENTIALS` service binding. Provider tokens,
OAuth codes, private keys, and raw secret values are prohibited from the
broker request, platform ledger, access bundles, and logs. The optional
Secrets Store adapter maps only `{ref, version}` to a named binding and a
bounded expiry; the token is read once at the custody boundary and returned
only in the short-lived broker response.

Dry-run the Worker with:

```bash
npx wrangler deploy --config workers/credential-broker/wrangler.toml --dry-run
```
