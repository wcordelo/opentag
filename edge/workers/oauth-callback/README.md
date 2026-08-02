# OAuth callback handoff

This Worker is the public callback boundary for a future connector OAuth
installation. It intentionally does not implement a provider exchange or
credential custody.

`GET /oauth/callback`:

1. requires the exact configured HTTPS callback origin and path;
2. validates the provider-returned state and the `opentag_oauth_nonce` cookie;
3. accepts either a bounded authorization code or a bounded provider error;
4. forwards the one-request handoff over an authenticated service binding; and
5. returns only an acceptance status, never provider response content.

The state, nonce, code, and provider error are not persisted or logged by this
Worker. The effecter must consume the one-use OAuth state, validate the
marketplace version and scopes, exchange the code outside OpenTag, and return
an opaque credential-custody reference. If the effecter is missing or rejects
the handoff, the callback fails closed.

Configure `OAUTH_CALLBACK_ORIGIN` as the exact origin registered with the
provider and set `OAUTH_EFFECTER_AUTH_TOKEN` interactively. Deploy the
effecter before this Worker. No provider token belongs in this Worker or in
OpenTag Durable Object state.
