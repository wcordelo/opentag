# `app/`

Legacy Node Slack bot entry is retired. `index.ts` exits with a pointer to the
Cloudflare path:

```bash
cd edge && npm run dev
pnpm runtime
```

This directory is not Slack ingress and does not own lifecycle state.

See [README.md](../README.md), [PRODUCT.md](../PRODUCT.md), and
[ARCHITECTURE.md](../ARCHITECTURE.md).
