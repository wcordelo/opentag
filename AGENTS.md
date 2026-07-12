# AGENTS.md

## Cursor Cloud / agent instructions

- **Product docs:** [`PRODUCT.md`](./PRODUCT.md) · [`README.md`](./README.md) · [`docs/README.md`](./docs/README.md)
- **Slack product surface:** Cloudflare edge (`edge/`) — Events API bot Worker + StateStore. Production Worker: `opentag-bot` (`npm run deploy:bot`). Channels deps: `edge/vendor/` tarball + npm.
- **Agent brain:** root `pnpm runtime` (`runtime.ts`) — AG-UI on `:8200`; Worker `AGENT_URL` points here (public host in production).
- **Research tasks:** optional `edge/wrangler.research.toml` (internal); not on the CI critical path.
- **Technical locks:** [`DECISIONS.md`](./DECISIONS.md)

### Root `pnpm start` is not the Slack bot

`pnpm start` / `pnpm dev` exit with a pointer to `cd edge && npm run dev`. There is no Socket Mode / Railway Slack bot.

### `edge/` is the testable CF target

```bash
cd edge
npm ci
npm test                 # bot-spine unit only
npm run test:e2e         # StateStore workerd
npm run typecheck
npm run deploy:bot       # production
npm run dev              # local bot Worker (Slack Events)
```

Slack Request URLs must point at **`opentag-bot`**, not the research orchestrator.
