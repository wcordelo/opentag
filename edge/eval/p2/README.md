# P2 Jev router shadow eval

Offline evaluation for the Slack respond/observe + needsHuman + memoryNeeded shadow prototype.

## Fixture set

`fixtures.json` contains router-heuristics cases from `edge/test/response-routing.test.ts` plus synthetic Slack snippets (`synthetic: true`). Each item includes:

- `input`: message text, ingress `source`, `channelType`, mention flag, optional `threadContext`, `hasFiles`
- `gold.route`: `respond` | `observe`
- `gold.needsHuman`: boolean
- `gold.memoryNeeded`: boolean (must be `false` when the message explicitly opts out of memory)

## Labeling guidelines

1. **route / respond** when the production ingress gate should admit a turn: DM, explicit mention, trusted trigger, file share, or unmentioned thread/channel text that matches action/question/problem heuristics in `response-routing.ts`.
2. **route / observe** for side chatter, phatic noise, questions to other humans, or explicit "don't reply" phrasing.
3. **needsHuman / true** only when a human teammate should own the message (legal/HR/security escalation, explicit request for a person, sensitive interpersonal issues). Routine bot tasks stay `false`.
4. **memoryNeeded / true** when answering well requires workspace-specific retrieval (past threads, wiki, code, prior decisions). General knowledge, greetings, and self-contained prompts stay `false`.
5. **memory opt-out**: if the user says "without using memory", "don't look anything up", etc., gold `memoryNeeded` is `false` regardless of topic. Production applies the same override deterministically in code (see `detectMemoryOptOut` in `jev-route-questions.ts`).

## Derived artifacts

Regenerate from production modules:

```bash
cd edge && REGENERATE_P2_EVAL=1 npx vitest run test/p2-eval-contract.test.ts
```

Writes:

- `current-router.json` — `classifySlackResponseRoute` output per fixture
- `question-definitions.json` — Jev state/questions shared with production

## Run Jev eval (requires `TYPESAFE_API_KEY`)

```bash
node edge/eval/p2/run-jev-eval.mjs --dry-run
TYPESAFE_API_KEY=... node edge/eval/p2/run-jev-eval.mjs
```

Outputs `jev-results.json` and `jev-results.md` with agreement, respond F1, false-respond delta vs current router, memoryNeeded metrics, latency, and model version.

## Cost

Shadow mode issues **one** SystemOne request per routed Slack message (three questions in parallel in the same request).
