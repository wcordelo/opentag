# OpenTag: an open-source alternative to Claude in Slack

Run your own AI agent inside Slack: it reads a thread, answers, calls your tools, and
renders rich results right in the conversation. Think of it as having Claude in your
workspace, except **open-source and self-hosted**: you own the runtime, bring your own
model, and wire it to your own tools. No per-seat pricing, no lock-in.

It's built on **[`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels)** —
CopilotKit's open SDK for chat-platform agents — hosted on **Cloudflare Workers** with a Node AG-UI runtime for the LLM.

## See it in action

https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135

▶️ **[Watch the demo](https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135)** (~50s) — an OpenTag agent working a Slack thread: it renders a breakdown, a table, and a bar chart inline (**generative UI**) and files a ticket only after an **Approve** gate (**human-in-the-loop**).

> **Two ways to run it:** **host it on your own** with the open-source SDK below — or skip the ops and **[sign up for the managed service →](https://go.copilotkit.ai/opentag-managed-gh)** coming soon from CopilotKit. The managed service will be part of our Enterprise Intelligence platform. You'll be able to use our cloud-hosting or enterprises can host it on their own infra.

## Quick start (self-hosted — Claude Tag on Cloudflare)

You'll run two processes: the **agent** (Node AG-UI) and the **bot Worker** (Slack Events API).

**1. Create a Slack app.** At [api.slack.com/apps](https://api.slack.com/apps?new_app=1) →
*From a manifest* → paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Install it,
then grab the **Bot User OAuth Token** (`xoxb-…`) and **Signing Secret**. Point Events /
Interactivity / slash command Request URLs at your Worker (`…/slack/events`, `…/commands`,
`…/interactions`). See [PRODUCT.md](./PRODUCT.md) and [edge/README.md](./edge/README.md).

**2. Build sibling CopilotKit channels packages** (edge uses `file:` deps):

```bash
cd ../CopilotKit   # sibling checkout
pnpm install
pnpm --filter @copilotkit/channels-ui --filter @copilotkit/channels --filter @copilotkit/channels-slack build
```

**3. Secrets** — `cp .env.example .env` for the runtime; `edge/.dev.vars` for the Worker:

```bash
# runtime (.env)
OPENAI_API_KEY=sk-...
AGENT_URL=http://localhost:8200/api/copilotkit/agent/triage/run

# edge/.dev.vars
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
AGENT_URL=http://localhost:8200/api/copilotkit/agent/triage/run
```

**4. Run it:**

```bash
pnpm runtime                 # agent backend :8200
cd edge && npm install && npm run dev   # Slack bot Worker
```

**5. Talk to it.** @mention the bot in a channel thread.

Full architecture: **[PRODUCT.md](./PRODUCT.md)** · **[edge/README.md](./edge/README.md)** · **[setup.md](./setup.md)**.

## Make it your own

OpenTag is deliberately small and hackable:

- **Change what it does.** The agent's behavior is steered by a system prompt in
  [`runtime.ts`](./runtime.ts) — rewrite it and you have a different agent.
- **Edge bot surface.** Tools/commands for Slack live under [`edge/src/`](./edge/src/);
  the Worker owns Events API ingress via `CloudflareSlackAdapter` + `createBot`.
- **Bring your own model + MCP.** Linear/Notion attach when credentials are present.

The Cloudflare product path is **[PRODUCT.md](./PRODUCT.md)**; deeper maps in
**[setup.md](./setup.md)** and **[edge/README.md](./edge/README.md)**.

## Cloudflare (Claude Tag host)

OpenTag on Cloudflare is the self-hosted Claude Tag path: Events API bot Worker,
Durable Object StateStore, channel config / access bundles, knowledge memory, and
long-running tasks (including research). See **[PRODUCT.md](./PRODUCT.md)** and
**[edge/README.md](./edge/README.md)**. Default deploy: `cd edge && npm run dev`.

## Don't want to host it yourself?

Self-hosting means you run and scale the runtime, persistence, and inspection tooling yourself.
A **managed CopilotKit service** is on its way. It's the same agent, without the ops: durable
threads, persistence, hosted inspection, and agents that improve from feedback (**Continuous
Learning from Human Feedback**). 

- **[Join the waitlist →](https://go.copilotkit.ai/opentag-managed-gh)** — be first in when the managed service opens.
- **[Talk to an engineer →](https://copilotkit.ai/talk-to-an-engineer)** — building something real on this? We'd love to help you ship it.

## Learn more

The **[CopilotKit Slack quickstart](https://docs.copilotkit.ai/slack)** is the canonical guide
to building a Slack agent — read it alongside this starter. Detailed setup and configuration
lives in **[setup.md](./setup.md)**.

## License

MIT — see [LICENSE](./LICENSE).
