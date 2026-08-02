# OAuth effecter boundary

`opentag-oauth-effecter` is the authenticated destination for the callback
handoff. It validates the bounded state/nonce/code-or-error contract and, when
configured, forwards it to a separately authenticated provider adapter.

The provider adapter protocol is defined in
`edge/src/platform/oauth-provider-contract.ts`. A successful adapter response
must be a bounded receipt containing the tenant/principal/connector identity,
the exact marketplace version, an opaque `credential:` reference, provider
subject, scopes, grant version, and issuance/expiry timestamps. Token-shaped
response fields are not accepted by the contract.

The effecter itself does not exchange a provider code, store tokens, or write
an OAuth grant. The adapter must perform state correlation, marketplace and
scope checks, provider exchange, and custody in its own authenticated control
plane before returning a receipt. With no adapter binding and separate bearer,
the effecter remains fail-closed with
`oauth_provider_adapter_unconfigured`.
