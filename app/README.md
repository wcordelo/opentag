# `app/`

Legacy Node Slack bot entry is retired. `index.ts` exits with a pointer to the
Cloudflare path:

```bash
cd edge && npm run dev
pnpm runtime
```

This directory is not Slack ingress and does not own lifecycle state.

See [README.md](../README.md), [docs/PRODUCT.md](../docs/PRODUCT.md), and
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
