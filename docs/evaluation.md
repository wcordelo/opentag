# Railway vs Cloudflare Evaluation

Run both tracks through the same scenario and record metrics.

## Test scenario

```
Objective: "Summarize the benefits and risks of Durable Objects for stateful agents"
Thread: slack:EVAL:C123:1234567890.000000
```

## Commands

```bash
# Railway (in-memory mock, no Postgres)
RESEARCH_MOCK=1 pnpm e2e:research

# Railway (with Postgres)
DATABASE_URL=postgres://... pnpm e2e:research

# Cloudflare (after wrangler dev)
curl -X POST http://localhost:8787/research \
  -H 'Content-Type: application/json' \
  -d '{"threadKey":"slack:EVAL:C:1","objective":"test"}'
```

## Comparison matrix

| Criterion | Railway + Postgres | Cloudflare DO | Notes |
|-----------|-------------------|---------------|-------|
| Time to first reply (p50) | _TBD_ | _TBD_ | Measure from mention to interim post |
| Time to final reply (p50) | _TBD_ | _TBD_ | Full research + verify |
| Cold start latency | _TBD_ | _TBD_ | First request after idle |
| Long job (25 min Parallel) | Worker poll | DO alarm | |
| Ops burden | Postgres + 3 processes | Wrangler + CF dashboard | |
| Estimated cost per 100 tasks | _TBD_ | _TBD_ | |
| Slack UX | Socket Mode streaming | Webhook posts | |
| Vendor lock-in | Low (Postgres portable) | High (DO/SQLite) | |
| Restart survival | Postgres WAL | DO SQLite WAL | |

## Record results

Sample from mock e2e run (`RESEARCH_MOCK=1 pnpm e2e:research`):

```
Date: 2026-06-28
Railway (in-memory) elapsed: ~124ms (2 fiber steps)
Railway p50 first reply: TBD (requires live Slack + Postgres)
Railway p50 final reply: TBD
CF p50 first reply: TBD
CF p50 final reply: TBD
```

Fill in after running against live infrastructure:

```
Date: ___________
Railway p50 first reply: ___ ms
Railway p50 final reply: ___ ms
CF p50 first reply: ___ ms
CF p50 final reply: ___ ms
Winner (latency): ___
Winner (ops): ___
Winner (cost): ___
Recommendation: ___
```

## Recommendation template

Based on initial implementation:

- **Choose Railway** if you want OpenTag's native Slack Socket Mode UX, portable Postgres, and minimal vendor lock-in.
- **Choose Cloudflare** if you need global edge latency, automatic per-object scaling, and can accept DO-specific APIs.

Both tracks share `lib/research/` — switching is primarily an adapter swap.
