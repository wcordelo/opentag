# Docs

Authoritative product and ops docs for OpenTag. Prefer these over any historical
migration notes (those have been removed).

| Doc | Purpose |
| --- | --- |
| [../README.md](../README.md) | Overview, quick start, features, deploy |
| [../PRODUCT.md](../PRODUCT.md) | Product north star and architecture spine |
| [../setup.md](../setup.md) | Setup walkthrough, Slack scopes, Linear create flow |
| [../DECISIONS.md](../DECISIONS.md) | Locked decisions (HITL, Slack API form bodies, email assignee, Containers) |
| [../edge/README.md](../edge/README.md) | Cloudflare Workers (bot + research) |
| [../edge/workers/agent-runtime/README.md](../edge/workers/agent-runtime/README.md) | Production AG-UI Container |
| [../AGENTS.md](../AGENTS.md) | Instructions for coding agents |
| [research-actors.md](./research-actors.md) | Research task Worker runbook |
| [evaluation.md](./evaluation.md) | Research eval / smoke commands |

Slack app manifest: [`../slack-app-manifest.yaml`](../slack-app-manifest.yaml)
(includes `users:read.email` — reinstall after scope changes).
