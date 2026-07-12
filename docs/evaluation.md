# Research task: Railway vs Cloudflare ops notes

> Historical bake-off notes. **Product direction is Claude Tag on CF** —
> see [`PRODUCT.md`](../PRODUCT.md). Both tracks still share `lib/research/`.

## Test scenario

```
Objective: "Summarize the benefits and risks of Durable Objects for stateful agents"
Thread: slack:EVAL:C123:1234567890.000000
```

## Commands

```bash
# Railway (in-memory mock)
RESEARCH_MOCK=1 pnpm e2e:research

# Cloudflare research Worker (internal)
curl -X POST http://localhost:8788/research \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $INTERNAL_SECRET" \
  -d '{"teamId":"T1","threadKey":"slack:EVAL:C:1","objective":"test"}'

# Preferred: via bot TaskRuntime
curl -X POST http://localhost:8787/tasks/start \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"type":"research","teamId":"T1","threadKey":"slack:C:1","channelId":"C","payload":{"objective":"test"}}'
```

## Notes

| Criterion | Railway + Postgres | Cloudflare DO |
|-----------|-------------------|---------------|
| Long job | Worker poll | DO alarm |
| Slack UX | Socket Mode (Railway bot) | Events API (CF bot Worker) |
| State | Postgres | DO SQLite |

Switching tracks is primarily an adapter swap on `lib/research/`.
