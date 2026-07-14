# `e2e/` — end-to-end probes

Helpers for live Slack and research-loop checks against a real workspace or
mock research adapters. Day-to-day bot coverage is **`cd edge && npm test`** and
**`npm run test:e2e`** (StateStore on workerd).

The automated suite covers pre-admission, concurrent threads, render/effect
fences, obligation replay, exact Stop across AG-UI/harness/research, remote-git
approval, egress policy, and coding postconditions. These helpers remain for
real Slack behavior that unit/workerd tests cannot prove.

## Layout

```text
e2e/
├── README.md           this
├── research-loop.ts    research actor loop (pnpm e2e:research)
├── run.ts              optional live Slack harness entry
├── cases.ts            Slack case catalog (legacy harness)
├── slack-api.ts        Slack Web API helpers
└── grab-user-token.ts  helper for user-token based probes
```

Telegram harness files (`telegram-*.ts`) are leftover from an abandoned multi-platform
track and are not part of the Claude Tag product. Prefer Slack + Cloudflare.

## Research mock loop

```bash
# from repo root
RESEARCH_MOCK=1 pnpm e2e:research
```

## Live Slack (edge scripts)

Prefer the edge local smoke path (signed Events API → real reply):

```bash
cd edge
./scripts/e2e-local.sh
pnpm runtime                 # terminal A (repo root)
npm run dev                  # terminal B
./scripts/e2e-smoke-local.sh
```

See [edge/README.md](../edge/README.md) and [docs/evaluation.md](../docs/evaluation.md).

## Env

Expect `SLACK_BOT_TOKEN` (and related secrets) in root `.env` / `edge/.dev.vars`.
Never commit tokens.
