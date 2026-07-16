# Trusted rich-payload trigger evidence

## Implemented behavior

- `edge/src/slack/rich-display-text.ts` walks only bounded, visible Slack rich
  payload fields. It supports nested rich-text user mentions and attachment
  text/fields while excluding hidden callback metadata and Block Kit action
  values. Traversal is cycle-safe and capped at 24,000 characters.
- `edge/src/slack/trusted-trigger.ts` parses exact bot/app identifiers, reports
  configuration readiness, recognizes the configured OpenTag bot user mention,
  and rejects missing targets, invalid-only allowlists, own-bot messages,
  untrusted actors, and payloads without an exact rich mention.
- Slack signature verification happens before trusted-trigger classification.
- `edge/src/slack/pre-admit-turn.ts` durably registers the execution and render
  obligation before any profile, configuration, Slack API, or runtime await.
- `edge/src/slack/ingress-normalize.ts` carries the exact automation identity
  into the normalized event; the normalizer and pre-admission classifier use
  the same actor semantics.
- `edge/src/slack/cloudflare-slack-adapter.ts` skips human profile lookup for
  trusted automation actors.
- `edge/src/slack/stop-routing.ts` prevents bot/app payloads from gaining Stop
  semantics.
- `edge/src/worker.ts` records admitted, rejected, duplicate, and readiness
  outcomes without logging the raw Slack payload.
- `edge/src/bot-engine.ts` applies the automation-safe tool ceiling and blocks
  human-only research, memory, coding, remote-git, and PR paths.
- Health/readiness reports invalid trusted-trigger configuration, including a
  missing target bot user ID, as unhealthy.

## Exactly-once behavior

- Stable Slack event identity and durable pre-admission deduplicate repeated
  Events API deliveries before a second harness execution can start.
- Stable `client_msg_id` values make ambiguous Slack render retries
  reconcilable: the same request is replayed and Slack's duplicate response is
  treated as evidence of the original application.
- Existing execution, effect, render, rejection, and Stop fences remain the
  authoritative lifecycle controls.

## Test evidence

- `edge/test/trusted-rich-trigger.test.ts` covers exact bot/app allowlisting,
  nested exact mentions, bounded traversal, cycles, own-bot rejection, invalid
  allowlists, missing target IDs, and hidden action-value exclusion.
- `edge/test/trusted-trigger-health.test.ts` covers healthy and fail-closed
  readiness states.
- `edge/test/pre-admit-turn.test.ts`,
  `edge/test/cloudflare-slack-adapter.test.ts`, and
  `edge/test/stop-command-routing.test.ts` cover actor propagation,
  users.info avoidance, durable admission, and Stop denial.
- `edge/test/slack-agent-stop.integration.test.ts` sends a signed Slack event
  through the production worker path and proves one harness turn, one output,
  safe permissions, channel runtime defaults, no profile lookup, no human
  attribution, no coding/remote-git/PR authority, and no duplicate work after
  exact redelivery.
- `edge/test/render-obligation.test.ts` covers ambiguous-response retry and
  stable client-message identity for both first and continuation pages.

## Activation boundary

The code and checked-in configuration templates are ready, but trusted
triggering remains inactive until an operator supplies exact Slack bot/app IDs
and the target OpenTag bot user ID in the deployment environment. No Slack app
installation or remote configuration mutation was performed by this goal.
