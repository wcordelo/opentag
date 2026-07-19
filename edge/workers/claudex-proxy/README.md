# OpenTag Claudex proxy

`opentag-claudex-proxy` is the private model backend for the production Claude
Code harness. It runs CLIProxyAPI in a Cloudflare Container and translates the
Anthropic-compatible requests emitted by Claude Code to the OpenAI Codex
backend. It is not a second coding harness: tools, repository access, Stop,
remote-git approval, and success postconditions remain owned by
`opentag-harness`.

## Trust boundary

- `workers_dev` is disabled; the harness reaches this Worker through the
  `CLAUDEX_PROXY` service binding.
- Only `GET /v1/models`, `POST /v1/messages`, and
  `POST /v1/messages/count_tokens` are accepted.
- Caller `authorization`, `x-api-key`, and internal headers are removed before
  forwarding.
- Codex OAuth JSON is loaded from the private `opentag-claudex-auth` R2 bucket,
  capped at 128 KiB, and persisted back after refresh.
- `CLIPROXY_CLIENT_KEY` authenticates model requests inside the proxy
  Container. `CLIPROXY_INTERNAL_KEY` separately authenticates OAuth
  import/export. Each must be a distinct random value of at least 32
  characters.
- The harness Container never receives Codex OAuth state or either real proxy
  key; it receives only a sentinel token.

## Configure

Complete `cliproxyapi --codex-login` on a trusted local machine. Upload only
the resulting `codex-*.json` file; never print or commit it:

```bash
cd edge/workers/claudex-proxy
npx wrangler r2 object put \
  opentag-claudex-auth/codex-primary.json \
  --file /absolute/path/to/codex-account.json \
  --remote

npx wrangler secret put CLIPROXY_CLIENT_KEY
npx wrangler secret put CLIPROXY_INTERNAL_KEY
```

`CODEX_AUTH_OBJECT` in `wrangler.jsonc` selects the R2 object key. The default
is `codex-primary.json`.

## Validate and deploy

```bash
npm ci
npm run typecheck
npm run deploy
```

Deploy in dependency order:

1. `opentag-claudex-proxy`
2. `opentag-harness`
3. `opentag-bot`

The proxy health response is healthy only when CLIProxyAPI is reachable and
Codex auth is configured. The end-user smoke test should go through Slack so it
also proves bot routing and harness execution:

```text
--claudex --model gpt-5.6-sol Reply with exactly: SLACK_CLAUDEX_OK
```

The accurate runtime description is: OpenTag launches the pinned Claude Code
CLI directly in a session-scoped, recyclable Cloudflare Container. Claudex
changes only the model backend. The harness creates a fresh writable `HOME`
for each execution and may reuse the session checkout and Container.

See [../../../docs/operations.md](../../../docs/operations.md) for the complete
runbook and rollback guidance.
