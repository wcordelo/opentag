# OAuth effecter boundary

`opentag-oauth-effecter` is the authenticated destination for the callback
handoff. The baseline validates the bounded state/nonce/code-or-error contract
and then fails closed with `oauth_provider_adapter_unconfigured`.

It does not consume OAuth state, exchange a provider code, store tokens, or
write an OAuth grant until a provider adapter, custody backend, tenant
isolation model, and marketplace trust review are explicitly configured. This
Worker exists so the public callback has a real, authenticated, fail-closed
destination rather than a placeholder service name.
