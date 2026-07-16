# Channel runtime defaults evidence

## Implemented behavior

- `edge/src/config/access-bundle.ts` defines and normalizes per-channel
  `ChannelRuntimeDefaults`, including the constraint that a channel model
  override requires the Claude Code harness.
- `edge/src/config/workspace-config-do.ts` performs additive, idempotent schema
  migration for `default_harness_type` and `default_model`. Existing channel
  rows remain valid and new defaults survive Durable Object restarts.
- `edge/src/store/thread-overrides.ts` resolves model and harness independently
  with provenance. The precedence is explicit message selection, sticky thread
  selection, channel default, then deployment default.
- Merely using a channel default does not persist it as a sticky thread
  override.
- `edge/src/commands/index.ts` provides `/config runtime show`, `set`, and
  `clear`. Automation actors cannot mutate channel configuration.
- The admin mutation path and Slack command path share normalization and
  validation, preventing one surface from accepting a configuration the other
  rejects.
- `edge/src/agent-turn.ts` passes the selected runtime and its provenance to the
  authoritative harness turn and permission snapshot.
- A selected but disconnected harness fails visibly. OpenTag does not silently
  substitute another harness or model.

## Test evidence

- `edge/test/runtime-defaults.test.ts` covers normalization, valid partial
  defaults, invalid combinations, and atomic rejection.
- `edge/test/thread-overrides.test.ts` covers per-field
  explicit/sticky/channel/deployment precedence and proves channel use does not
  become sticky.
- `edge/test/store.workers.test.ts` covers migration, persistence, show/set/
  clear behavior, and restart survival.
- `edge/test/agent-turn-overrides.test.ts` and
  `edge/test/agent-turn-harness.test.ts` cover runtime selection, provenance,
  and visible failure when the selected runtime is unavailable.
- `edge/test/slack-agent-stop.integration.test.ts` covers a signed trusted
  automation event using the configured channel Claude default on the actual
  worker path.

## Operational evidence

- `docs/extending.md` documents precedence and the distinction between
  explicit, sticky, channel, and deployment selections.
- `docs/operations.md` documents the `/config runtime` operator workflow,
  validation behavior, and the fact that defaults require separate deployment
  support for the selected harness.
- `DECISIONS.md` records independent per-field precedence as a durable
  architecture decision.
