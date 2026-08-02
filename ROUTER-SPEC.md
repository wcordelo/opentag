# OpenTag Request Router — Three-Tier Dispatch Spec

Status: **product/architecture spec; decided direction with shadow implementation live**

## Current implementation status — 2026-08-01

This document remains the product/architecture contract. The implementation
status is no longer “not built”: `edge/src/router/classifier.ts`,
`heuristics.ts`, `shadow.ts`, `measurement.ts`, and
`measurement-do.ts` implement the v1 heuristic classifier and workspace
measurement ledger. `edge/src/slack/response-routing.ts` now adds the
implemented ingress response-worthiness gate that decides whether a Slack
thread event should enter that lifecycle at all. The Slack lifecycle records
counterfactual tier decisions and dispatches Tier 2 while `shadowOnly` remains
true.

A live admin summary/list confirmed Tier 1 counterfactual records, conservative
fallbacks, outcomes, and workspace-scoped storage. Tier 1 answer dispatch,
model classification, billing, user-facing escalation, and Tier 3 compute are
still dark. Read [docs/current-state.md](./docs/current-state.md) for live
versions, evidence, rollout gates, and the reason these remaining gates are
intentional. Historical “not built” wording below describes the design point
before the shadow implementation landed.

Owner: Will Lopez-Cordero
Decided: 2026-07-31

This document specifies the request router: the component that classifies
every incoming request and dispatches it to one of three execution tiers. It
is the authoritative expansion of `VISION-SPEC.md` §4.5. It is a product and
architecture spec, not an implementation guide: it says what the router does,
why it exists, and what is undecided. Contracts it depends on live in
`KNOWLEDGE-BASE-SPEC.md` (Tier 1 retrieval) and `ARCHITECTURE.md` /
`PRODUCT.md` (Tier 2 behavior). Nothing here relaxes any existing invariant —
Slack traffic still terminates only at `opentag-bot`, and all of Layer 1's
fences, obligations, and approvals apply unchanged to whatever the router
dispatches.

### Implemented ingress gate: response-worthy versus observe

The three-tier router is not a reason to wake the agent for every Slack
message. Before tier classification, verified Slack thread events pass through
`classifySlackResponseRoute()`:

| Input | Ingress decision |
| --- | --- |
| DM, explicit bot mention, trusted trigger, or file share | `respond` |
| Unmentioned question, action request, or problem report in a thread | `respond` |
| Passive conversation in a thread | `observe`; preserve Slack history, do not admit a turn |
| Top-level unmentioned channel chatter | ignore at normalization |
| Duplicate threaded `message` for an `app_mention` | ignore before pre-admission |

This gate uses the existing versioned classifier plus bounded lexical signals;
it does not call a model, change Router Tier 1/Tier 3 rollout state, or bypass
Layer 1 fences. A `respond` decision proceeds to normal Tier 2 admission and
shadow measurement. An `observe` decision must not create an active-turn row.
The final render confirmation remains the owner of deleting a response-worthy
turn's exact active row. This separation is what prevents a discarded Slack
duplicate from leaving the false “active turn” warning.

---

## 1. What the router is and why it exists

The router is a classification and dispatch stage that sits in front of all
response-worthy execution. Every incoming Slack event (mention, DM, thread
reply, command) is first evaluated by the ingress gate; response-worthy
messages and every API call then pass through the tier router before any agent
session is created. Passive thread conversation is observed rather than routed
to a tier. API callers will likely self-declare their tier rather than be
classified (open question, §8.6), but they still pass through the router's
gates, dispatch, and accounting:

| Tier | Name | Latency | Cost | What runs |
| --- | --- | --- | --- | --- |
| 1 | KB dispatch | sub-2s | near-zero | Knowledge-index retrieval + re-rank + cited answer; **no agent session** |
| 2 | Agent dispatch | seconds | moderate | Stateful Durable Object agent session (today's behavior) |
| 3 | Sandbox dispatch | minutes–hours | higher | Long-running container execution: builds, complex workflows, multi-step code |

**Why it exists — three reasons:**

1. **Economics.** Without a router, every "where's the deploy runbook?"
   pays the full cost and latency of an agent turn. Most questions a
   company asks its own knowledge base are lookups, not tasks. If the
   majority of request volume resolves at Tier 1 for near-zero marginal
   cost, hosting thousands of workspaces is viable; if everything is Tier
   2, it is not. The router is where the platform's unit economics are
   enforced, not just measured.

2. **Latency as product quality.** A cited answer in under two seconds
   feels like asking a colleague who knows. The same answer after eight
   seconds of agent spin-up feels like a chatbot. Tier 1 is the knowledge
   moat (Layer 4) given a direct product surface.

3. **Tier 3 needs a front door.** Long-running sandbox work — "rebuild the
   docs site against the new API," "run the migration against staging and
   report" — is the current gap in the platform. It cannot simply hang off
   a Tier 2 session (wrong lifetime, wrong cost profile, wrong user
   expectations about progress and interruption). A request has to be
   *recognized* as Tier 3 work at ingress so it can be confirmed, priced,
   and dispatched with the right machinery.

**Where it lives in the stack.** The router is a lightweight, stateless
classification path inside the ingress Worker (`opentag-bot`), deliberately
**not** a Durable Object. Why not a DO: the router holds no state that must
survive the request — classification inputs are the message plus cheap
lookups, and the durable record of the decision is written to the existing
event/ledger machinery by whichever tier executes. Putting a DO hop in front
of every request would add latency and a serialization point to the exact
path whose reason for existing is being fast and cheap. Slack ingress
invariants are unchanged: signature verification, prompt acknowledgement,
and `waitUntil` scheduling stay exactly as specified today; the router runs
after acknowledgement, on the dispatch side.

The router is a *narrow waist*: one place where every request, from every
surface, becomes a tier decision. Future surfaces (web client, API,
`/mcp/knowledge` callers) reuse the same classifier rather than growing
their own dispatch logic.

## 2. Tier definitions and contracts

### Tier 1 — KB dispatch

The request is answered directly from the Layer 4 knowledge index: hybrid
search against Supermemory (per `KNOWLEDGE-BASE-SPEC.md`), re-rank the
candidate chunks, compose a short cited answer, reply. No agent session, no
DO turn, no tools beyond retrieval.

The architecture reference is Cerebras's internal KB: 15k+ queries/day
spanning Slack, GitHub, Jira, and Docs, served from a single Postgres table
of embeddings plus metadata, with fast inference making it practical to
re-rank 20+ chunks in under 500ms. The design lesson is not the specific
stack (OpenTag's index is Supermemory, and the residency question is open —
`VISION-SPEC.md` §10.2) but the shape: **one simple retrieval store, one
dispatch path, aggressive re-ranking made affordable by cheap fast
inference, no per-question agent machinery.** Resist the urge to make Tier 1
smarter by making it more agentic; that is Tier 2's job.

Tier 1 inherits every retrieval contract from `KNOWLEDGE-BASE-SPEC.md`
unchanged: exact `workspace:{teamId}` tag derivation, policy filtering,
bounded results, citations always carrying the retrieved revision, and safe
degradation when the index is unavailable. A Tier 1 answer must be visibly a
KB answer — cited, scoped, and carrying an affordance to escalate ("want me
to dig deeper?") that re-dispatches the request to Tier 2.

Tier 1 hard-depends on the knowledge layer being live for the workspace.
Until the B-series gates pass for a workspace, its router runs with Tier 1
disabled and everything falls through to Tier 2 — which is exactly today's
behavior, and is the backward-compatibility story.

### Tier 2 — agent dispatch

What OpenTag does today, unchanged: a stateful Durable Object session
handling multi-turn tasks, drafts, analysis, tool use (including
`search_slack`), and MCP connectors, with the full Layer 1 trust contract —
active-turn fences, render obligations, HITL approvals, Stop. Tier 2 is the
default tier: when the classifier is unsure, it dispatches here, because
Tier 2 can do everything Tier 1 can (slower, at cost) and can hand off to
Tier 3 (with confirmation). The router never makes Tier 2 worse; it only
diverts traffic that never needed it.

### Tier 3 — sandbox dispatch

Long-running execution: code builds, multi-step workflows, tasks measured in
minutes to hours. This is the tier that does not exist yet.

**Substrate decision: Cloudflare Containers (beta) primary, E2B as
documented fallback.** The why, stated fully because it is the most
consequential choice in this document:

- **Same platform, same model.** The Layer 2 harness already runs its
  per-session coding sandbox on Cloudflare Containers; the sentinel-
  credential, egress-interception, and HITL-approval machinery is built for
  and proven on this substrate. Tier 3 extends that contract to longer
  lifetimes instead of introducing a second security model to audit.
- **Same tenancy and billing.** Containers sit inside the Cloudflare
  account and per-`teamId` tenancy story that Layers 1–3 already assume.
  One vendor's metering feeds the platform's cost accounting (§5).
- **The beta risk is real and named.** Containers shipped in beta;
  pricing, duration limits, and region coverage can change. That is why
  E2B — a hosted sandbox service purpose-built for agent code execution —
  is the documented fallback, kept viable by confining Tier 3's contract
  to things both substrates can satisfy (isolated execution, injected
  scoped credentials, bounded lifetime, exportable artifacts). The
  switch-trigger criteria are an open question (§8).
- **The rule: no custom sandbox. Ever.** Building a bespoke sandbox
  orchestrator — scheduler, node fleet, image plumbing, credential
  distribution — is precisely the Kubernetes path Centaur took, and the
  operational gravity OpenTag was designed to escape. A custom sandbox
  would silently reintroduce the platform team that §7 of the vision spec
  promises no one needs. If both Cloudflare Containers and E2B somehow
  become untenable, the correct move is a third *vendor*, not a first
  *fleet*.

**Competitive frame.** The closest existing product to Tier 3 is Conductor
(Melty Labs): a Mac app orchestrating parallel Claude Code / Codex agents
in isolated git worktrees, with per-agent branches, transcripts, and review
flow. Conductor proves the demand; its limits — Mac-only, developer-only,
local to one laptop — are what Tier 3 removes. Tier 3 is the same category
made cloud-native, multi-tenant, and Slack-native: anyone in the org can
trigger the work from a message, and the job's state is durable company
record rather than a laptop artifact (`VISION-SPEC.md` §8). Honest scoping:
Tier 3 as specced here is single long-running jobs; Conductor-style
*parallel* agent orchestration (fan-out, per-branch review) is a plausible
later evolution of the tier, not part of this spec.

Tier 3 dispatch is never silent: because it is slow and expensive, the
router's dispatch includes an up-front confirmation in Slack (what will run,
roughly how long, and — once §6's pricing lands — at what cost), and the
running job posts durable progress into the thread using the same render-
obligation machinery as Tier 2. Stop must work against Tier 3 jobs with the
same authority it has over Tier 2 turns.

## 3. The classifier — how a tier is chosen

The classifier maps (message, context) → (tier, confidence, primary
signal). It answers exactly one question: **does this request require
*knowing* something or *doing* something?** Knowing → Tier 1. Doing →
Tier 2 (or Tier 3, with confirmation). Everything in this section is in
service of answering that one question fast, cheaply, and with a known
error profile. The classifier does not plan, decompose, or interpret the
request beyond the tier decision (§7's scope fences apply).

Values in this section are marked **[decided]** or **[recommended]**.
Recommended values are the numbers implementation should start from; they
are expected to be tuned against real dispatch data (§3.6) and each is
listed as a confirmation item in §3.7.

### 3.1 Decision architecture

The decision runs in three stages, strictly in order. Each stage either
produces a final tier or passes the request to the next stage. **[decided]**

```
    Slack event ──▶ ingress response gate ──▶ observe / ignore (short-circuit)
                              │ respond
                              ▼
    message ──▶ Stage 1: explicit commands ──▶ tier (short-circuit)
                    │ no match
                    ▼
            Stage 2: hard gates ──▶ constrain eligible tiers
                    │
                    ▼
            Stage 3: heuristics (§3.2) ──▶ tier (if pattern fires cleanly)
                    │ ambiguous
                    ▼
            Stage 3b: model call (§3.3) ──▶ (tier, confidence, signal)
                    │
                    ▼
            threshold check (§3.4) ──▶ final tier
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
     Tier 1      Tier 2          Tier 3
   retrieve →   spawn DO       confirm →
   inject →     session        dispatch job
   compose
```

**Stage 1 — explicit commands win outright.** A slash command, quick
action, or product-defined tier-bound form short-circuits everything.
Users who know what they want are never second-guessed by a model.

- `/ask where is the deploy runbook` → Tier 1 (subject to Stage 2 gates).
- `/task rebuild the docs site against the new API` → Tier 3
  confirmation flow.
- A "dig deeper" button click on a Tier 1 answer → Tier 2, with the
  Tier 1 attempt attached (§3.5).
- A reply inside a thread with an active Tier 2 session → that session,
  always. The router never fragments ongoing work; classification only
  applies to requests that start a new turn outside an active session.
  Example: the user says "actually also check the staging config" as a
  reply in a live agent thread — no classification happens at all.

**Stage 2 — hard gates constrain the eligible set.** Gates are read from
`WorkspaceConfigDO` (the existing single source of policy truth, §7) plus
router-local health state:

- **Tier 1 gate:** the workspace's knowledge layer is live (B-series
  gates passed per `KNOWLEDGE-BASE-SPEC.md`) *and* the index is currently
  healthy (not in the `knowledge_unavailable` degraded state). If either
  fails, Tier 1 is removed from the eligible set and the request cannot
  be classified into it no matter what Stage 3 says. Example: a brand-new
  workspace asks "what did we decide about pricing?" — a perfect Tier 1
  question on its face, but the KB gate is closed, so it dispatches to
  Tier 2, which answers it with `search_slack` if the tool is available
  or from general context if not. This is the cold-start behavior (§3.7).
- **Tier 3 gate:** the capability is enabled for the workspace and the
  requesting user is authorized for it. A non-authorized user saying
  "run the migration against staging" gets Tier 2, which will explain
  what it can and cannot do — never a silent Tier 3 dispatch.
- Tier 2 has no gate. It is always eligible; it is the floor.

**Stage 3 — heuristics first, model for the remainder.** Cheap
regex/pattern matching (§3.2) resolves the unambiguous majority with zero
model calls and near-zero latency. Only messages the heuristics cannot
resolve cleanly go to the model call (§3.3). The model's output passes
through the threshold rules in §3.4 before becoming a dispatch.

**Where context injection happens.** Retrieval is *not* part of
classification. The classifier decides the tier first, on the message and
cheap context alone; only after a Tier 1 decision does the Tier 1
executor run retrieval (hybrid search + re-rank per
`KNOWLEDGE-BASE-SPEC.md`), build the injected context block (§3.5), and
compose the cited answer. **[decided]** Rationale: running retrieval
speculatively before classification would put index latency in front of
every request, including the Tier 2/3 majority-cost paths that never use
the results. The one consequence to accept: the classifier commits to
Tier 1 without knowing whether retrieval will actually find anything. A
Tier 1 dispatch whose retrieval comes back empty or below the relevance
floor is handled inside the Tier 1 executor as an automatic fall-through
to Tier 2 (recorded as `tier1_miss`, §3.6) — the user sees a slightly
slower agent answer, never an empty "I found nothing" from the fast path.

**Relationship to `search_slack`.** These are two entry points into the
same retrieval backend, and they must not be confused:

- **Tier 1** calls the retrieval client directly from the router's
  dispatch path and injects results into a one-shot synthesis prompt at
  build time. No agent session, no tool call, no mid-turn loop.
- **`search_slack`** is a Tier 2 *tool*: an agent session, mid-turn,
  decides it needs corpus context and calls it like any other tool.

The classifier never routes to Tier 1 "because the agent could have
searched" — the routing question is whether the *whole request* is a
lookup, not whether retrieval might be useful somewhere inside a task.
Example: "summarize what #infra decided about the queue migration and
draft an RFC from it" contains a retrieval need but *is* a construction
task — it matches both pattern families in §3.2 (retrieval opener plus a
coordinated construction verb), so it goes to the model, which routes it
Tier 2, where the agent will call `search_slack` itself. A Tier 2
session that calls `search_slack` is never retroactively reclassified,
and a Tier 1 answer never invokes the tool machinery. Both paths share
the retrieval client, the `workspace:{teamId}` tag derivation, policy
filtering, and the `knowledge_unavailable` degradation contract, so scope
and safety behavior are identical regardless of entry point. **[decided]**

### 3.2 Heuristic layer (pre-model)

The heuristic layer is pattern matching over the normalized message
text, evaluated as two pattern *families* (no intra-family precedence —
any match in a family counts as that family matching). Normalization,
in order: lowercase; strip the bot mention; strip a courtesy prefix if
present (`^(please |can you |could you |would you |pls )+`) before any
anchoring or word counting; collapse whitespace. Fenced code blocks and
quoted text are excluded from both pattern matching *and* word counts,
but their presence is recorded as a feature. The layer exists because
most messages are not ambiguous, and a model call spent on "where is
the deploy runbook?" is pure waste. A heuristic decision is recorded
with `classifier_path: "heuristic"` and the matched rule id as the
primary signal (§3.6).

**A message resolves heuristically only if exactly one tier's pattern
family matches.** If a Tier 1 pattern and a Tier 2/3 pattern both match,
or none match, the message goes to the model. **[decided]** This
mixed-signal rule is what keeps the heuristics safe: they only claim the
easy cases.

**Anchoring semantics [decided]:** Tier 1 patterns are anchored at the
start of the normalized message. Tier 2/3 patterns match at the start
*or* immediately after a clause boundary (a conjunction or punctuation:
`\b(and|then)\s+`, `[,;]\s*`). The clause-boundary rule is what catches
"summarize the #infra discussion **and draft** an RFC" as a mixed match
(→ model) while leaving "where is the **deploy** runbook?" a clean
Tier 1 match — construction verbs appearing as mid-sentence nouns or
modifiers do not trigger the Tier 2 family.

**The tables below are the v1 pattern table**, not illustrations: the
implementation ships exactly these entries (as a versioned table —
rule ids `t1.01`…, `t2.01`…, version pinned in the dispatch record via
`matched_rule`) and extends them only through the §3.6 tuning loop.
"Construction verb," wherever this section says it, means exactly the
verbs listed in the Tier 2/3 table for the pinned table version.

**Tier 1 trigger patterns — retrieval shapes:**

| Pattern (regex, v1 table) | Example message it catches |
| --- | --- |
| `^(what|when|why|how|where|who|which)\b` | "what did we decide about the queue migration?" |
| `^(what did we|what was|what's our)\b` | "what's our policy on schema changes?" |
| `^who knows( about)?\b` | "who knows about the billing retry logic?" |
| `^where (is|are|was|does|do|can i find)\b` | "where is the deploy runbook?" |
| `^(did we|have we|has anyone)\b` | "did we ever ship the retry backoff fix?" |
| `^(summarize|recap|catch me up on|tl;?dr)\b` | "summarize last week's #infra discussion" |
| `^(when did|when was|when do)\b` | "when did we cut over to the new API?" |
| `^(link|find|show) (me )?(the|that|our)\b` | "find me the thread where we argued about tombstones" |
| `^(update me on|give me an update on|any update on|status on|status of)\b` | "update me on the queue migration" |
| `\?$` on a message ≤ 15 words (code blocks excluded from the count) containing no construction verb in any position | "supermemory re-rank budget?" |

**Tier 2/3 trigger patterns — construction and mutation shapes.** A
match here (with no Tier 1 match) resolves to Tier 2; Tier 3 is *never*
chosen heuristically — heuristics may at most flag "looks like Tier 3"
as a feature passed to the model, because Tier 3 requires high confidence
plus confirmation (§3.4). **[decided]** In this table, `^` means the
family's anchor points per the anchoring semantics above: message start
*or* immediately after a clause boundary.

| Pattern (regex, v1 table) | Example message it catches |
| --- | --- |
| `^(build|run|deploy|execute|migrate|rebuild)\b` | "run the migration against staging and report" |
| `^(fix|debug|investigate|patch)\b` | "fix the flaky ledger test" |
| `^(write|draft|create|make|generate|compose)\b` | "draft an RFC for the queue migration" |
| `^(open|file|create) (a |the )?(pr|ticket|issue)\b` | "open a PR that bumps the pinned Supermemory release" |
| `^(analyze|compare|review|audit)\b` | "analyze last quarter's incident postmortems for patterns" |
| `^(add|remove|update|change|rename|delete)\b(?! (me|us)\b)` | "update the on-call rotation doc" — the negative lookahead is the "update me on" carve-out; the Tier 1 idiom row above claims those |
| message > 80 words (code blocks excluded from the count) AND (≥3 bullet/numbered lines OR contains "acceptance criteria" / "requirements:") | a pasted mini-spec → Tier 2 (and sets `tier3_flag`, below) |

**Two non-pattern rules in the same family [decided]:**

- **Code veto:** a fenced code block never *matches* a family, but its
  presence vetoes heuristic Tier 1 resolution. "why does this throw?
  \`\`\`ts …\`\`\`" — the `^why` Tier 1 pattern matches but is vetoed;
  no Tier 2 pattern matches; the message goes to the model (where it is
  one of the §3.3 few-shot boundary cases, and the expected answer is
  Tier 2 — debugging pasted code is work, not lookup). If a Tier 2
  pattern *does* match a code-bearing message ("fix this: \`\`\`…\`\`\`"),
  it resolves Tier 2 heuristically as normal.
- **`tier3_flag` producer:** the flag in `surface_features` (§3.3) is
  set when the long-spec rule fires, or when the matched Tier 2 verb is
  in the designated long-running subset {run, deploy, execute, migrate,
  rebuild}. The flag never resolves a tier itself — it is only an input
  feature to the model, consistent with "Tier 3 is never chosen
  heuristically."

**Edge cases, decided here so implementations don't relitigate them:**

- **Imperative questions are Tier 1.** "tell me what the deploy process
  is", "explain our tombstone handling", "remind me who owns billing" —
  imperative in form, retrieval in substance. The pattern family
  `^(tell me|explain|describe|remind me)\b` followed by an interrogative
  complement (`what|how|why|who|where|when|about`) maps to Tier 1.
  Counter-example that stays Tier 2: "tell the #infra channel that the
  migration is done" — imperative with a *side effect*, no interrogative
  complement.
- **"update me on X" is Tier 1.** "update" as a retrieval idiom is an
  explicit Tier 1 pattern row, and the Tier 2 `^update\b` pattern
  carries a negative lookahead for *me/us* (both in the tables above):
  "update me on the queue migration" → Tier 1; "update the migration
  doc" → Tier 2. The disambiguator is the direct object: *me/us* →
  retrieval, an artifact → work.
- **"can you…" strips to its complement.** Courtesy prefixes are removed
  during normalization (list above), before anchoring and word counts:
  "can you find the thread where we discussed rate limits?" classifies
  as "find the thread…" → Tier 1. "can you open a PR for this?" →
  Tier 2.
- **Greetings and phatic messages** ("thanks!", "good bot", "hey") match
  neither family → model call, which will route them to Tier 2 where the
  session machinery handles conversational turns. Not worth special
  heuristics.

**Coverage estimate: 60–70% of Slack traffic resolves heuristically,
with the remainder going to the model.** **[recommended — honest
status: this is an estimate from the shape of Centaur-lineage traffic
and the Cerebras reference workload, not a measured number.]** The
router ships with shadow-mode logging (§3.6) precisely so this number is
measured in week one; if measured coverage is materially below 50%, the
pattern table gets expanded before the model bill does.

### 3.3 Model-based classification

**Latency budget.** The Tier 1 promise is sub-2s end-to-end. Working
decomposition of that 2,000ms: Slack ack and dispatch overhead ~100ms;
retrieval + re-rank ~500–700ms (the Cerebras reference number for
re-ranking 20+ chunks is <500ms); answer synthesis ~600–900ms; Slack
post ~150ms. **That leaves the classifier ≤150ms round-trip, with
~100ms as the design target.** **[recommended]** Be honest about the
arithmetic: the component ceilings sum to exactly 2,000ms with zero
slack, so these are p95 budgets to be enforced per component, not
typical values — a request where every component hits its ceiling is
already at the promise's edge, which is why the classifier target is
100ms and 150ms is the disqualification line. This is the hard
constraint on model choice: any candidate whose p95 round-trip exceeds
150ms is disqualified regardless of accuracy, because a classifier that
eats the latency budget of the tier it protects is self-defeating. Note
the budget applies only to the ~30–40% of traffic that reaches Stage 3b;
heuristic-resolved traffic pays effectively nothing (recorded as
`classify_latency_ms: 0` by convention, §3.6).

**Input.** The classifier model receives a fixed, small context — never
the full conversation, never retrieved chunks — serialized as a single
JSON object in the user turn (one stable field order, so prompt-cache
prefixes hold): **[decided as shape; depths and enum boundaries
recommended]**

| Field | Content | Why |
| --- | --- | --- |
| `message` | The normalized message text, truncated to 1,000 chars | The primary signal |
| `history` | Up to the last 3 messages in the thread, sender-role-tagged, each truncated to 200 chars | Enough to catch "yes do that" follow-ups; shallow enough to stay in budget |
| `surface_features` | Booleans/counts precomputed by the heuristic pass: has_code_block, has_attachment, word_count, matched_tier1_pattern, matched_tier2_pattern, tier3_flag | The model reuses the heuristic layer's work instead of re-deriving it |
| `workspace_maturity` | Enum: `kb_cold` (Tier 1 gate closed, or <500 indexed documents) / `kb_young` (<5,000 documents or KB live <60 days) / `kb_mature` (otherwise) — boundaries [recommended] | Calibrates Tier 1 eligibility expectations; a mature KB makes more questions answerable |
| `user_tier3_authorized` | Boolean | The model never proposes Tier 3 for an unauthorized user |
| `explicit_hint` | `"fast"` \| `"thorough"` \| `null`, extracted by a small versioned phrase list in the heuristic pass ("just answer quickly", "quick answer" → `fast`; "take your time", "do it properly" → `thorough`) | User hints are honored as strong priors, not commands (commands are Stage 1) |

The model does **not** receive: retrieval results (retrieval happens
after classification, §3.1), user identity beyond the authorization
boolean, per-workspace historical priors in v1 (designed-in for v2 once
the misroute ledger has volume — §3.6), or any content from other
channels.

**Output.** Structured, schema-enforced (constrained decoding /
JSON-schema mode — the model is not trusted to freeform): **[decided]**

```json
{
  "tier": 1 | 2 | 3,
  "confidence": 0.0–1.0,
  "primary_signal": "retrieval_verb" | "construction_verb" |
                    "question_form" | "code_present" |
                    "long_spec_form" | "conversational" |
                    "explicit_hint" | "history_continuation" |
                    "other"
}
```

Three fields, nothing else. `primary_signal` is a closed enum, not free
text — it exists for the dispatch record and the retraining loop
(§3.6), and a closed vocabulary is what makes it aggregatable. A
malformed or schema-violating output is treated as classifier failure →
Tier 2 (§4's classifier-unavailable rule).

**Prompt design.** The failure mode to engineer against is not accuracy
in the abstract — it is the model *overthinking*: treating
classification as an invitation to reason about the task, pad output, or
hedge. Countermeasures, all **[decided as requirements, wording
recommended]**:

- The system prompt states the one question verbatim — "does this
  request require knowing something or doing something?" — and defines
  the tiers in three sentences each, in terms of what *runs*, not what
  the request "is about".
- **Few-shot examples, 8–12, chosen to be boundary cases, not easy
  cases.** The easy cases never reach the model (the heuristics took
  them), so a prompt full of "where is X? → Tier 1" examples trains it
  on traffic it will never see. The shots should be the §3.2 edge cases:
  "update me on the migration" → 1; "tell #infra the migration is done"
  → 2; "why does this throw? ```…```" → 2; "can you find that thread"
  → 1; a pasted mini-spec → 3.
- Max output tokens capped at the size of the JSON schema (~40 tokens).
  No reasoning field, no chain-of-thought — at this budget, thinking is
  latency, and the decision is simple enough that visible reasoning adds
  failure modes (hedged half-answers) rather than accuracy.
- Confidence is defined *operationally* in the prompt: "0.9+ means a
  human reading this message would not disagree with the tier; 0.5 means
  a coin flip." Uncalibrated confidence is useless to §3.4, so the
  prompt anchors the scale with examples at 0.95, 0.8, and 0.5.

### 3.4 Fallback and bias rules — thresholds

The costs are asymmetric, and the thresholds encode the asymmetry:

- A **Tier 1 misfire** (user wanted action, got a KB answer) costs a
  confusing wrong-shape response, a manual escalation, and a dent in
  trust — the user asked for work and got a citation. Example: "handle
  the queue migration" misread as a question about the queue migration.
- A **Tier 2 false positive** (user wanted a lookup, got an agent) costs
  a few seconds and some tokens. The user still gets a correct answer —
  the agent can call `search_slack` and produce the same content,
  slower. Example: "where is the deploy runbook?" routed to Tier 2 is a
  waste, not a failure.

Therefore the classifier must be *hard to convince* into Tier 1 and
*easy to default* into Tier 2. Concrete rules:

- **Tier 1 commitment threshold: confidence ≥ 0.80.** A model output of
  `(tier: 1, confidence: 0.74)` dispatches to Tier 2. **[recommended
  starting value — to be tuned against the measured escalation rate;
  the tuning rule is: if Tier 1 escalation rate exceeds the §8.1
  accuracy bar (working number <10%), raise the threshold before
  touching the model.]**
- **Confidence floor / default:** there is no separate floor below which
  "something else" happens — the rule is simply that *anything that is
  not a ≥0.80 Tier 1 or a ≥0.90 Tier 3 flag is Tier 2*. Tier 2 is not a
  fallback tier; it is the default tier that the other two must earn
  traffic away from. **[decided]**
- **Tier 3 flag threshold: confidence ≥ 0.90, and the flag never
  dispatches compute.** A ≥0.90 Tier 3 classification produces the
  confirmation prompt ("this looks like a long-running job — want me to
  run it as one?"); anything below produces a plain Tier 2 dispatch, and
  the Tier 2 session may itself propose Tier 3 mid-task (§8.7). The
  worst possible Tier 3 inference error is therefore one unnecessary
  confirmation prompt, never unwanted billed compute. **[decided as
  structure; 0.90 recommended]**
- **Gates are absolute.** If the model returns a tier that Stage 2
  removed from the eligible set (e.g. `(tier: 1, confidence: 0.95)` in a
  workspace whose KB gate is closed), the dispatch is Tier 2 and the
  record keeps both the model's answer and the eligible set — the
  disagreement is itself useful telemetry. Thresholds apply only within
  the eligible set. **[decided]**
- **Heuristic decisions carry implicit confidence 1.0** for accounting
  purposes but are subject to the same escalation-feedback loop — a
  heuristic rule whose Tier 1 dispatches get escalated above the
  accuracy bar is demoted from the pattern table to a model feature.
- **Classifier failure** (timeout at 150ms, malformed output, model
  error) → Tier 2, always, per §4. The classifier is an optimization,
  never a dependency.

### 3.5 Context injection contract (Tier 1)

After a committed Tier 1 decision, the executor retrieves, filters, and
injects context directly into the synthesis prompt — one shot, no tool
loop. The injected block is structured so the synthesis model can cite
mechanically and so the block itself is auditable in the dispatch
record:

```
<kb_context workspace="{teamId}" retrieved_at="{iso8601}" query_id="{id}">
  <chunk id="c1" source="slack#infra/2026-05-12T14:03" revision="r7"
         score="0.91" author_scope="channel-visible">
  We decided to keep the queue consumer single-threaded until the
  ledger refactor lands; revisit after B8. …
  </chunk>
  <chunk id="c2" source="wiki/deploy-runbook" revision="r31" score="0.84" …>
  …
  </chunk>
</kb_context>
```

**[decided as required fields; serialization shape recommended]** Per
chunk: stable citation id, source locator (surface + channel/page +
timestamp), the revision that was retrieved (inherited verbatim from the
`KNOWLEDGE-BASE-SPEC.md` citation contract — a citation without a
revision is a contract violation), re-rank score, and the policy scope
under which the chunk was visible (`author_scope` values come from the
knowledge spec's policy-filter vocabulary, not defined here). The
synthesis prompt instructs the
model to answer *only* from the block and to cite chunk ids inline; the
renderer maps chunk ids back to Slack permalinks / source links.

**Token budget: 4,000 tokens for the injected block, K ≤ 8 chunks.**
**[recommended]** The budget counts the full serialized block including
tags and attributes, measured with the synthesis model's tokenizer.
Overflow handling: chunks are admitted in re-rank order, whole chunks
only — a chunk that does not fit entirely is skipped and admission
*continues* down the ranking to smaller chunks that do fit
(greedy-skip, not stop-on-first-miss **[decided]**); a chunk is never
truncated mid-text, because a half-chunk is a misquotation factory. If
the top-ranked chunk alone exceeds the budget
(a pathological ingest), Tier 1 falls through to Tier 2 with the
`tier1_miss` reason `chunk_overflow`. A relevance floor (minimum re-rank
score, tuning value owned by the knowledge spec) applies before
admission; zero admitted chunks → `tier1_miss` → Tier 2 fall-through,
per §3.1.

**The escalation affordance.** Every Tier 1 answer — no exceptions —
renders with the escalation control ("want me to dig deeper?" as a
button/quick action). **[decided]** It appears always, not just on
low-confidence answers, because the user is the misroute detector of
last resort and the affordance is the sensor. Triggering it dispatches a
Tier 2 session whose opening context contains the original message, the
Tier 1 answer, and the chunk ids it cited (so the agent extends rather
than repeats the work), and writes an `escalated_explicit` outcome to
the misroute ledger (§3.6). Implicit escalation is deliberately narrow
in v1 **[decided as scope]**: a reply in the Tier 1 answer's thread,
from the same user, within 10 minutes, that either matches a small
versioned dissatisfaction phrase list ("that's not what I meant", "no,
actually…", "not helpful") or restates the question — any such reply
re-dispatches to Tier 2 the same way and is recorded as
`escalated_implicit`. The detector is conservative on purpose: a missed
implicit escalation costs one lost training label (the user can still
press the button); a false positive hijacks a normal conversational
reply into an unwanted agent session. Other replies in the thread are
ordinary new messages and classify normally.

### 3.6 Observability and the improvement loop

Per-request, the classifier writes its portion of the §5 dispatch record
at dispatch time. Classifier-specific fields (all category-level, never
message text, per the knowledge spec's logging rules):

- `classifier_path`: `explicit_command` | `hard_gate` | `heuristic` |
  `model` | `classifier_failed`. `hard_gate` is used only when Stage 2
  collapses the eligible set to {Tier 2} (Tier 1 gated off *and* Tier 3
  not enabled/authorized), in which case Stage 3 is skipped entirely —
  outside shadow mode there is nothing left to classify. When the
  eligible set retains ≥2 tiers, the path is whatever Stage 3 stage
  decided, with the gate constraint visible via `eligible_tiers`.
- `matched_rule`: versioned pattern-table rule id (heuristic path) or
  `primary_signal` enum value (model path)
- `tier_decided` (what the classifier concluded), `tier_dispatched`
  (what actually ran — differs from `tier_decided` under gates, shadow
  mode, and `tier1_miss` fall-through), `confidence`, `eligible_tiers`
  (post-gate set)
- `classify_latency_ms` (0 by convention for heuristic path)
- Tier 1 executor adds: `tier1_outcome`: `answered` | `tier1_miss`
  (with miss reason: `empty_retrieval` | `below_relevance_floor` |
  `chunk_overflow` | `index_unavailable`) | `escalated_explicit` |
  `escalated_implicit`; plus injected-chunk count and token count.
- **Shadow mode:** while a workspace's Tier 1 gate is closed for
  *configuration* reasons (B-series gates not passed, or rollout
  dark-ship), the classifier still runs the full Stage 3 pipeline and
  records `tier_decided` as the counterfactual, tagged `shadow: true`,
  with `tier_dispatched: 2` for everything. **[decided]** Transient
  index unavailability in an otherwise-enabled workspace is *not*
  shadow mode — it is the §4 degradation path, recorded as
  `tier1_miss: index_unavailable`, so a 30-second outage does not
  pollute the shadow dataset. This is how the
  coverage estimate (§3.2), threshold values (§3.4), and accuracy bar
  (§8.1) get real data before a single user is exposed to a Tier 1
  answer.

**Misroute feedback, three channels:** explicit escalation (button
press), implicit escalation (dissatisfied follow-up to a Tier 1 answer,
§3.5), and declined Tier 3 confirmations. Each writes a labeled example
— (message text, extracted features, decided tier, corrected tier) — to
the misroute ledger (§5). Note the deliberate carve-out: the *dispatch
record* telemetry is category-level and never contains message text,
but the misroute ledger does store the message text of misrouted
requests — it has to, or tuning steps 1 and 3 below are not executable
— under stricter access (operator-only, retention-bounded, the same
handling class as the knowledge index itself). There is deliberately no
fourth channel of silent
inference ("the user didn't react, so it was right"): absence of
escalation is weak positive signal and is recorded as such
(`answered`, unconfirmed), not treated as ground truth.

**The tuning loop, in escalation order** — cheapest lever first,
**[decided as an ordering]**:

1. **Weekly (automatable): pattern-table review.** Heuristic rules whose
   escalation rate exceeds the accuracy bar are demoted; high-volume
   model-path messages with consistent decisions and low escalation
   become candidate new patterns. Pattern table changes are versioned
   and recorded in the dispatch record (`matched_rule` carries the
   version), so accuracy is comparable across versions.
2. **On threshold breach: threshold moves.** If Tier 1 escalation rate
   breaches the bar workspace-wide, raise the 0.80 commitment threshold
   first — it is a config change with same-day effect.
3. **Monthly-scale: prompt/few-shot revision.** The misroute ledger's
   worst boundary cases replace the weakest few-shot examples.
4. **Last: model replacement or fine-tuning.** Only when the ledger
   holds enough labeled misroutes to evaluate a candidate offline
   (minimum corpus size is open — §8.1), and only if steps 1–3 have
   plateaued above the accuracy bar. Per-workspace priors as classifier
   input (the §3.3 v2 item) slot in here.

### 3.7 Classifier-specific open questions and confirmation items

These extend §8; the general accuracy question is §8.1 and the model-
choice question is §8.4. Specific to this section:

1. **Model choice — recommendation to confirm.** The 150ms budget
   effectively rules out frontier-API round-trips: Haiku-class models
   over the Anthropic API measure in the hundreds of milliseconds TTFT
   from a Worker, which fails the budget before accuracy is even
   discussed. The recommendation is a **small instruct model on Workers
   AI with JSON-schema-constrained output** (on-platform, no egress
   hop, ~40 output tokens): it keeps the classifier inside the
   Cloudflare tenancy/billing story like everything else, and its
   latency is plausibly within budget — *plausibly*, because the budget
   is a target, not a demonstrated number, and the first implementation
   task is measuring p95 round-trip from the ingress Worker. Documented
   fallback if even that is too slow: **embedding-similarity
   classification** (embed the message, nearest-centroid against
   per-tier example sets — single-digit-ms, no generation), accepting
   lower boundary-case accuracy in exchange for effectively zero
   latency. The fallback honors the same output contract by
   construction: `tier` from the nearest centroid, `confidence` from a
   calibrated mapping of the similarity margin (calibration curve fit
   on shadow-mode data), `primary_signal` fixed to `"embedding_nn"`
   (added to the enum), so §3.4's thresholds and §3.6's records apply
   unchanged whichever engine is running. A dedicated fine-tuned classifier is the eventual likely
   endpoint (step 4 of the tuning loop) but is not buildable before the
   misroute ledger has volume. **Status: recommendation, not decided.**
2. **Accuracy vs. KB maturity.** As a workspace's KB grows, more
   questions become genuinely Tier 1-answerable, so classifier *recall*
   on Tier 1 (not just precision) starts to matter — every retrieval-
   shaped question misrouted to Tier 2 is margin burned, and at the §9
   vision targets (>60% Tier 1 in mature workspaces) recall is the
   binding metric. The `workspace_maturity` input (§3.3) is the v1
   mechanism; whether mature workspaces need per-workspace thresholds
   or priors is open. Measurement: track Tier 1 share and model-path
   Tier 2 decisions with `question_form` signals — that intersection is
   the recall-loss estimate.
3. **Cold start.** Confirmed behavior **[decided]**: Tier 1
   hard-gated off until the workspace passes its B-series gates;
   everything dispatches to Tier 2 (exactly today's behavior); the
   classifier runs in shadow mode (§3.6) from day one so that when the
   gate opens, the workspace's thresholds start from observed traffic
   rather than fleet defaults. Open: the minimum shadow-mode volume
   before the gate opening is trusted, and whether `kb_young`
   workspaces should run a temporarily raised commitment threshold
   (e.g. 0.90) while their corpus is thin and `tier1_miss` rates are
   naturally high.
4. **Recommended values to confirm against shadow-mode data** (each
   marked [recommended] above): the 150ms classify budget and its
   decomposition, the 0.80 / 0.90 thresholds, the 60–70% heuristic
   coverage claim, the 4,000-token / K≤8 injection budget, and the
   history depth (3 messages) fed to the model.

**Bias rules, restated as the section's summary:** when confidence is
low, choose Tier 2 — it can do everything, merely slower and costlier.
Never choose Tier 3 on inference alone below the high-confidence
threshold, and never without explicit user confirmation before compute
spins up. The asymmetry is deliberate: a Tier 1 misroute wastes trust, a
Tier 2 false positive wastes seconds, and a Tier 3 misroute would waste
real money — so the system is built so the last of these cannot happen
from inference alone.

## 4. Fallback and degradation behavior

The router must never make the system less reliable than the no-router
baseline (everything → Tier 2). Explicit rules:

- **Tier 1 unavailable** (index down, timeout, degraded search): fall
  through to Tier 2 transparently. The user gets a slower answer, never an
  error caused by an optimization. This mirrors the `search_slack`
  `knowledge_unavailable` contract.
- **Tier 1 answered but wrong-scope:** the answer carries an escalation
  affordance; one user action re-dispatches to Tier 2 with the Tier 1
  attempt attached as context. Escalations are recorded as misroute signal.
- **Tier 3 unavailable** (Containers outage, beta limit hit, capability
  not yet shipped, budget exhausted): the router does *not* silently
  downgrade an hours-long build into a Tier 2 turn that will time out or
  half-finish. It tells the user explicitly: what was requested is Tier 3
  work, Tier 3 is unavailable (and why, when known), and what the options
  are — queue the job for when capacity returns, run a bounded Tier 2
  approximation ("I can draft the plan and the diff, but not execute it"),
  or cancel. Honest refusal over degraded pretense; a Tier 2 session
  masquerading as a sandbox job is exactly the kind of silent failure the
  Layer 1 contract exists to prevent.
- **Classifier unavailable** (model call fails, times out): dispatch to
  Tier 2. The classifier is an optimization, never a dependency; its
  failure mode is the status quo ante.
- **Router bypass:** an operator/admin kill switch forces all traffic to
  Tier 2 per workspace, restoring exactly today's behavior. This is also
  the rollout mechanism: the router ships dark, then Tier 1 enables per
  workspace behind the same kind of gate discipline the B-series uses.

## 5. Observability and cost attribution

Every request carries a dispatch record from ingress to completion. The
router writes the classification portion (tier, confidence, latency) at
dispatch time via the same durable machinery the executing tier uses for
its outcome — so a request that fails *between* classification and tier
execution still leaves a record, and the never-silent contract covers the
gap the router introduces. The record contains:

- **Per-request:** tier chosen, classifier confidence and dominant signals
  (redacted — signal categories, never message text, consistent with the
  knowledge spec's logging rules), whether a hard gate or explicit command
  short-circuited, dispatch latency, execution latency, outcome
  (answered / escalated / failed / cancelled), and measured cost (model
  tokens for Tiers 1–2; container compute time for Tier 3).
- **Per-workspace aggregates:** tier mix (share of volume per tier), Tier 1
  hit rate and escalation rate, Tier 3 job count/duration/spend, and
  cost-per-tier — the numbers `VISION-SPEC.md` §9 now tracks (Tier 1 ≥40%
  at 12 months, >60% in mature workspaces at 24) and the numbers billing
  (§6) and the platform console will surface to workspace admins.
- **Misroute ledger:** every escalation of a Tier 1 answer and every
  user-declined Tier 3 confirmation is recorded as labeled classifier
  feedback. This is the raw material for the historical-patterns signal
  and for answering the accuracy question (§8) with data instead of
  anecdotes.

Why this is a spec-level requirement and not an ops nicety: the router's
entire justification is economic and experiential claims ("majority at Tier
1," "sub-2s," "Tier 3 is priceable"). Unmeasured, those claims are
marketing. The dispatch record is how the platform knows which tier handled
what, at what cost — and it is the audit trail a paying customer's admin
sees.

## 6. Mapping to the pricing model

The tiers give the hosted product's pricing its natural shape (direction,
not final pricing — the business-model boundary is `VISION-SPEC.md` §10.3):

- **Tier 1 — included.** Near-zero marginal cost means KB answers are
  effectively free to serve; bundling unlimited (fair-use) Tier 1 into
  every plan makes the knowledge moat the thing every user touches daily,
  which drives the ingestion → usage → memory flywheel.
- **Tier 2 — metered.** Agent sessions cost real model tokens; plans carry
  an included allowance with metered overage. The dispatch record (§5) is
  the meter.
- **Tier 3 — premium.** Sandbox jobs are the expensive tier and the
  clearest willingness-to-pay signal ("the org can trigger real builds
  from Slack"): gated to paid plans, with per-job or per-minute pricing
  and admin-set budgets. Exact structure is open (§8; `VISION-SPEC.md`
  §10.14).

The router is what makes this pricing *honest*: tier assignment happens at
a single choke point with a recorded rationale, so a customer's bill
decomposes into "answers (free), sessions (metered), jobs (premium)"
rather than an opaque token count. Self-hosters get the same router and
the same per-tier accounting against their own Cloudflare bill.

## 7. What the router is not

Scope fences, to prevent drift:

- **Not an agent.** The classifier makes one cheap decision; it does not
  plan, decompose tasks, or chain tiers on its own. Multi-tier workflows
  (a Tier 2 session spawning a Tier 3 job) are initiated by the executing
  tier with user confirmation, not by the router.
- **Not a queue or scheduler.** Tier 3 job lifecycle management is Tier
  3's machinery; the router only classifies and hands off.
- **Not a second policy engine.** Capability gates read from
  `WorkspaceConfigDO`, the existing single source of policy truth.
- **Not a rewrite.** Tier 2 is untouched; the router ships dark and
  defaults everything to Tier 2 until per-workspace enablement.

## 8. Open questions

Undecided, honestly. Each needs an owner and a decision date.

1. **Classification accuracy bar and measurement.** What Tier 1 escalation
   rate is acceptable before the router is a net harm (working number:
   <10%, unvalidated)? Is accuracy measured purely by user escalations, or
   also by sampled human audits of dispatch records? What is the minimum
   corpus of labeled misroutes before the historical-patterns signal is
   trusted? *This is the biggest unresolved question: if classification
   accuracy is bad, every other section of this document is moot.*
2. **Cloudflare Containers beta exposure.** What concrete changes at GA —
   pricing above X, max job duration below Y, region gaps — trigger the
   E2B fallback? Is fallback per-workspace or fleet-wide? Who owns
   tracking the beta? (The no-custom-sandbox rule is locked; the vendor
   choice under it is explicitly revisitable.) *This is the second-biggest:
   Tier 3's substrate is a beta product with unfixed terms.*
3. **Tier 3 cost model.** Pass-through metering, bundled allowance,
   per-job quote-and-approve, admin budgets — which, and how does BYO-key
   (§10.3 of the vision spec) interact with container compute, which has
   no customer-suppliable key?
4. **Classifier model choice.** Which small/fast model, run where (Workers
   AI keeps it on-platform; an external fast-inference provider may be
   cheaper/faster), and does it need per-workspace fine-tuning or just
   per-workspace priors as context?
5. **Tier 1 answer composition.** Does Tier 1 return retrieval + template
   composition, or a small-model synthesis over the chunks? Synthesis
   reads better but reintroduces hallucination risk into the tier whose
   promise is "cited, from your corpus."
6. **API-surface classification.** Slack messages have rich context; bare
   API calls may not. Do API callers self-declare tier (probably), and is
   the classifier then Slack-only?
7. **Mid-flight reclassification.** A Tier 2 session that discovers it
   needs an hour of compute: is the handoff to Tier 3 a new confirmed
   dispatch (current assumption) or a session upgrade? What happens to the
   session's state and fences during the handoff?
8. **Router placement at platform scale.** Inside `opentag-bot` today; if
   §10.1 of the vision spec lands on Workers-for-Platforms per-tenant
   dispatch, does the router live in the platform dispatcher or in each
   tenant Worker?
