# Semantic-Algos Integration

## Current implementation status — 2026-08-01

This document records the semantic-algorithm prompt/spec integrations. It is
not a deployment or feature-completeness claim. The current runtime evidence,
router shadow status, native Nanocodex canary, knowledge retrieval result, and
remaining production gates are maintained in [current-state.md](./current-state.md).


Source: [kousun12/semantic-algos](https://github.com/kousun12/semantic-algos) — a stdlib of reasoning procedures for LLMs.

Two skills (`triage`, `cassandra`) are **user-space programs** described in the README but not shipped as installed skills. They are defined here by composing the primitives that do ship.

---

## Skills integrated and where

| Skill | Source | Integration point |
|---|---|---|
| `assumption-audit` | `skills/assumption-audit/SKILL.md` | Harness `[Reasoning Procedures]` |
| `inversion` | `skills/inversion/SKILL.md` | Harness `[Reasoning Procedures]` |
| `first-principles-thinking` | `skills/first-principles-thinking/SKILL.md` | Harness `[Reasoning Procedures]` |
| `pre-mortem` (= `cassandra`) | README user-space program; composed from `inversion` | Harness `[Reasoning Procedures]` |
| `triage` | README user-space program; composed from routing logic | KB spec §13 planner routing |
| `dp-solve` | `skills/dp-solve/SKILL.md` | KB spec §13 compound query handling |
| `assumption-audit` | `skills/assumption-audit/SKILL.md` | KB spec §13 planner self-audit |

---

## A. Harness `[Reasoning Procedures]` — exact text added

Added as the final section of `containers/harness/SYSTEM_PROMPT.md`.

The `|` prefix matches the harness prompt convention. Each procedure is named so the agent can invoke it by name in its reasoning.

```
[Reasoning Procedures]
|Named reasoning patterns for hard turns. Apply them when the problem shape matches; name the procedure you are using so the user can follow the reasoning.
|
|**assumption-audit** — use before committing to any plan with irreversible steps or significant time cost.
|1. State the plan.
|2. Extract assumptions by category: Factual (beliefs about the world), Causal (X will produce Y), People (what others will do), Continuity (current conditions persist), Capability (we can execute this), Definitional (the framing itself).
|3. Rate each assumption: Load (breaks plan / degrades / survives if false), Confidence (evidence strength, not felt certainty), Testability (cheap / expensive / hindsight-only).
|4. Name the keystone: the assumption with the highest load and lowest confidence.
|5. Propose the cheapest test for the keystone before proceeding.
|6. State what the plan looks like if the keystone fails — is there a fallback?
|
|**inversion** — use when a goal is clear but the path is not, or when a plan needs stress-testing.
|1. Invert: "How would I guarantee this fails?"
|2. Enumerate 5–10 failure modes: operational, slow/silent, self-inflicted, environmental.
|3. Rank by likelihood × damage.
|4. Negate the top failure modes into concrete guards.
|5. State the affirmative plan derived from the guards.
|
|**pre-mortem** — use before executing risky, hard-to-reverse changes (schema migrations, destructive file operations, auth changes, force-pushes).
|This is the cassandra program from semantic-algos: inversion applied to a specific planned action, with failure propagation.
|1. State the planned action.
|2. Invert it: "What would make this go badly?" — enumerate the failure modes specific to this action.
|3. Pick the strongest failure mode. Propagate it: what does the codebase/system look like one week after this failure?
|4. Name the specific guard, check, or rollback path that prevents or recovers from it.
|5. Only proceed if the guard is in place, or explicitly surface the unguarded risk to the user before acting.
|
|**first-principles-thinking** — use when the conventional approach may be cargo-culted, or when the problem has been framed by analogy to a different system.
|1. List the current assumptions and inherited defaults shaping the approach.
|2. Separate what must be true (technical constraints, logical requirements, hard dependencies) from what is merely customary.
|3. Identify the irreducible fundamentals: technical primitives, logical requirements, economic constraints, framework guarantees.
|4. Rebuild possible solutions from those fundamentals.
|5. Compare the rebuilt answer to the conventional one. Name the practical difference and whether it matters here.
```

### Adaptations

**`cassandra` → `pre-mortem`**: The README defines `cassandra` as a user-space program that "inverts a plan, propagates its strongest failure mode, and writes the result as a dated post-mortem from the future." The literary framing (future post-mortem narrative) is dropped in favor of a direct engineering checklist. The operational substance — invert the action, pick the strongest failure mode, propagate its consequences, name the guard — is preserved intact. Renamed `pre-mortem` to match the engineering term already in use at this company and to avoid the literary connotation.

---

## B. KB spec §13 additions — exact text added

Added as a new subsection `### 13.1 Triage routing, compound query decomposition, and planner self-audit` appended to `KNOWLEDGE-BASE-SPEC.md §13`.

```markdown
### 13.1 Triage routing, compound query decomposition, and planner self-audit

The planning pass implements three reasoning patterns from the semantic-algos library.

**Triage routing** (`triage` user-space program) — the planner inspects the *shape* of the query and routes it based on a decision procedure rather than keyword matching:

| Query shape | Default arm(s) | Notes |
|---|---|---|
| "How does X work / where is X implemented?" | `code` | Implementation questions; strip prose preamble, extract identifiers |
| "Has anyone hit / did we ever / what happened with X?" | `slack` | Historical questions; extract the incident/topic noun |
| "Who built / who knows / who should I ask about X?" | `experts` | Expertise lookup; extract the topic, not the person question |
| "What changed in / recent PRs for X?" | `prs` | Recency questions; extract repo or path |
| "Why does / how do we / what's the right way to X?" | `slack + code` | Compound: past discussion + current implementation |
| Ambiguous or cross-cutting | `slack + code` | Default per §13 |

The planner prompt already encodes the default (`slack + code` when unsure). These shapes extend it into a concrete routing decision tree that the prompt should follow explicitly. Add the table above to the planner system prompt as "Query routing guide."

**Compound query decomposition** (`dp-solve` reasoning pattern) — when a query contains overlapping sub-questions (e.g., "why is the Vectorize index slow and what's the fix?"), the planner should:

1. Decompose into sub-queries: one diagnostic sub-query (→ `slack` + `code`) and one solution sub-query (→ `code` + `prs`).
2. Detect overlap: "what caused the slowness" is a shared sub-problem across both arms — it should appear as the `query` string for both, not duplicated with different words.
3. Emit up to 3 arm entries in the plan, rewriting each query to the best search string for that arm's retrieval model (identifiers for `code`, natural-language resolution language for `slack`).

The output schema (§13) already supports multiple arm entries; this pattern governs *when* to use them for compound queries rather than collapsing everything into one query string.

**Planner self-audit** (`assumption-audit` pattern) — the planner carries one implicit load-bearing assumption per arm it selects: that the arm's retrieval modality is the right signal for this query. If the planner emits a `code` arm for "what did we decide about auth token storage," the assumption is that the decision is captured in code rather than a Slack thread — which is often wrong. The planner system prompt should include the instruction: "Before finalizing an arm selection, check: is this query's answer more likely to live in code (implementation facts) or discussion (decisions, incidents, rationale)? Correct any arm whose assumption is wrong."

**Revised planner system prompt** (replaces the condensed version in §13):

> You are the retrieval planner for an engineering knowledge base. Given a user query, decide which retrieval arms to fan out and rewrite the query for each arm.
>
> **Step 1 — Identify query shape.** Is this asking about: (a) current implementation ("how does X work", "where is X"), (b) past decisions or incidents ("what did we decide", "has anyone hit"), (c) recent changes ("what changed", "recent PRs"), (d) expertise ("who knows about X"), or (e) a compound question combining multiple of the above?
>
> **Step 2 — Route to arms.** Use this routing guide:
> - Implementation → `code` (rewrite: extract identifiers and function/file names)
> - Past decisions/incidents → `slack` (rewrite: extract the topic noun; drop question framing)
> - Recent changes → `prs` (rewrite: extract repo, path, or feature name)
> - Expertise → `experts` (rewrite: extract the topic, not "who knows about")
> - Compound → decompose into sub-queries; emit one arm entry per sub-query (max 3 total)
> - Ambiguous → `slack + code` with the original query text
>
> **Step 3 — Audit.** For each arm you selected, confirm: "Is this query's answer more likely to live in this arm's data?" If not, swap the arm. A decision question routed to `code` is usually wrong.
>
> Return only the JSON plan.
```

### Adaptations

**`triage`** is a user-space program defined in the README as "inspect the shape of a question and route it to direct answering, causal analysis, option comparison, assumption testing, or question formulation." The KB planner is already a router, so the adaptation translates triage's abstract routing categories into the four concrete arms (`slack`, `code`, `prs`, `experts`) and adds the explicit decision tree.

**`dp-solve`** is adapted from its general form (decompose a problem into overlapping subproblems, build a memo table, synthesize) to the narrow case of compound queries in a retrieval planner. The "memo table" is the shared sub-query string reused across arms; the "synthesis" is the RRF fusion that already happens downstream. No structural change to the retrieval pipeline is needed.

**`assumption-audit`** is applied not to the user's code change but to the planner's own routing decision. The "keystone assumption" of any arm selection is whether the answer lives in that arm's data — exactly the class of planning mistake the planner is prone to. One audit step (Step 3) covers it without adding latency.
