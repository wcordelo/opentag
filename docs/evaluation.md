# Research evaluation notes

Quick commands for exercising the research **task** plane. Product surface is
the Claude Tag bot — see [`PRODUCT.md`](../PRODUCT.md).

Exact cancellation and late-delivery suppression are part of the evaluation
contract; see [research-actors.md](./research-actors.md) and the operational
checks in [operations.md](./operations.md).

## Via bot TaskRuntime (preferred)

```bash
curl -X POST http://localhost:8787/tasks/start \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"type":"research","teamId":"T1","threadKey":"slack:C:1","channelId":"C","payload":{"objective":"test"}}'
```

## Direct research Worker (internal)

```bash
curl -X POST http://localhost:8788/research \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $INTERNAL_SECRET" \
  -d '{"teamId":"T1","threadKey":"slack:EVAL:C:1","objective":"Summarize Durable Objects for stateful agents"}'
```

## Mock loop (no Slack)

```bash
RESEARCH_MOCK=1 pnpm e2e:research
```

Both Cloudflare DO and optional Postgres tracks share [`lib/research/`](../lib/research/).
Full runbook: [research-actors.md](./research-actors.md).
