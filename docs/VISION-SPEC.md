# OpenTag — Vision Spec

Status: **long-term vision, authoritative for direction**
Owner: Will Lopez-Cordero
Updated: 2026-08-01

## Current implementation reconciliation — 2026-08-01

This vision remains authoritative for direction, not for deployed status. Read
[docs/current-state.md](./current-state.md) before interpreting any later
section that says Layer 3, the router, knowledge, or Buzz is not built. The
merged OpenTag baseline is `ff8d649`; the current reconciliation deployment
also includes the narrow identity-read fix in `9d4538c`.

Current facts: Layer 1 and Layer 2 are deployed; native typed Nanocodex and
Claudex are live-verified through Slack; Layer 3 metadata contracts and the
secret-free effect ledger are synthetic-live; the router is implemented in
shadow mode; Slack knowledge retrieval is live-verified with eventual-indexing
caveats; the Slack ingress response-worthiness gate is live-verified; and Buzz
wake admission is present but currently fail-closed. Drive,
Linear, external MCP, OAuth, billing, deletion, authenticated Buzz admission,
Tier 1/Tier 3 routing, and provider reconciliation remain gated.

The locked tenancy model is one shared Worker fleet with strict per-team
Durable Object isolation. Worker Secrets are the deployment/bootstrap
configuration path, not a complete per-tenant OAuth/token store. The complete
feature matrix and open-gap ledger are in [docs/current-state.md](./current-state.md).


This document says where OpenTag is going and why. It is not a sprint plan.
For what is implemented today, `PRODUCT.md` and `ARCHITECTURE.md` are
authoritative. For locked technical choices, `DECISIONS.md`. For the knowledge
layer execution plan, `KNOWLEDGE-BASE-SPEC.md`. For the request router and
three-tier dispatch model, `ROUTER-SPEC.md`. Where this document and those
disagree about *current* state, they win; where they are silent about
*direction*, this document wins.

---

## 0. Current state — read this first

The detailed bullets in this historical vision section were written before the
2026-08-01 rollout. For current implementation truth, use
[docs/current-state.md](./current-state.md); the bullets below retain the
directional baseline and are not deployment evidence.

Calibrate everything below against these facts as of July 2026:

- **Team:** OpenTag is built and operated by one person, Will Lopez-Cordero.
  There is no company yet, no funding, and no revenue. The §9 targets assume
  the project gains resourcing (a small team, or funding, or both) during the
  first six months; that is itself an open question (§10.11).
- **Users:** the author's own workspaces. Zero external production workspaces
  today — which is why the 6-month goals are phrased as "first 5 external
  workspaces," not growth percentages.
- **Built at the historical review point:** Layers 1 and 2 were implemented and
  hardened. The later rollout added Layer 3 metadata/effect contracts,
  actor-bound knowledge controls, the native typed Nanocodex adapter, and the
  router's heuristic shadow ledger. See the current-state record for which of
  those are live, synthetic-live, or still gated.
- **This quarter's focus:** drive the knowledge layer through its gated
  rollout while completing tenant-scoped custody/effect execution and
  collecting router shadow evidence. The locked tenancy choice is one shared
  Worker fleet with strict per-team Durable Object isolation.

If a term below is unfamiliar — Centaur, Claudex, Buzz, Supermemory, "render
obligation" — Appendix B defines every piece of project vocabulary. Read with
it open.

## 1. What we're building

**One sentence:** OpenTag is a company operating system you deploy with one
click on Cloudflare — it starts as the smartest agent in your Slack and grows
into the durable memory and working brain of your entire company.

**Expanded:** Today, OpenTag is a Slack-native AI agent. You invite it to your
workspace, write in a thread, and it decides whether a message is worth
answering: a tag is optional for clear asks while conversational noise stays
quiet. It answers questions, files tickets, runs long research tasks, and
writes and ships code against your repositories —
with human approval gates on anything that touches the outside world. It runs
entirely on Cloudflare Workers, Durable Objects, and Containers: no
Kubernetes, no Rails, no servers anyone has to operate.

Tomorrow, OpenTag is a platform. A company signs up on a website, OAuths into
Slack, and gets a fully provisioned agent — identity, state, connectors, and
knowledge index — without touching a config file. Every conversation the agent
participates in, and eventually every tracked source (wikis, repos, databases),
feeds a per-workspace knowledge layer. The agent stops being a chatbot that
answers from a model's general knowledge and becomes a system that knows *your*
company: what was decided, by whom, where the bodies are buried, and what the
answer was the last three times someone asked.

The product arc, in one line: **smartest agent in your Slack → brain of your
company.**

Why this matters: every AI assistant on the market resets to zero on every
conversation. The compounding asset is not the model — models are rented and
interchangeable — it is the accumulated, structured, retrievable record of a
company's actual work. OpenTag is built so that asset accrues to the customer,
in their own deployment, from day one.

## 2. Who it's for

**Primary: small-to-mid software companies (roughly 5–200 people) that run on
Slack.** Their engineering leads want an agent that can answer "how does our
billing retry logic work?" from the actual codebase and the actual thread where
it was debated — and then open the PR that fixes it. They have no dedicated
platform team and no appetite for operating agent infrastructure. One-click
deploy is not a nice-to-have for them; it is the difference between adopting
and not adopting.

**Secondary: technical Slack communities and self-hosters.** OpenTag is open
source and began life as a self-hosted Claude-in-Slack alternative. Operators
who want to run their own instance on their own Cloudflare account can, and
that population is our contributor base, our hardest-to-please QA, and our
credibility with the primary persona. The hosted platform (Layer 3) must never
break the self-host path; it is a managed wrapper around it, not a fork.

**Not for (now):** enterprises that require on-prem or air-gapped deployment;
organizations not on Slack (Teams/Discord are explicitly out of scope in
`DECISIONS.md`); consumers. We may revisit surfaces later — the agent,
harness, and knowledge layers are surface-agnostic by construction — but the
next two years are Slack-first, because that is where the target companies'
work already lives.

Why the persona matters: it disciplines every roadmap argument. A feature that
delights a 10,000-seat enterprise but adds a deployment step for a 30-person
startup is a regression.

## 3. The problem

Companies trying to put AI to work today hit the same four walls:

1. **Assistants are stateless.** ChatGPT, Claude.ai, and Slack's own AI answer
   from general knowledge plus whatever you paste in. The context that makes an
   answer *correct for this company* — the decision thread from March, the
   constraint in the deploy runbook — is scattered across Slack, wikis, and
   repos, and no one is going to paste it in every time. Institutional
   knowledge walks out the door with every departing employee, and the tools
   don't capture it.

2. **Agents that do real work are operationally expensive.** The systems that
   can actually execute — run code, open PRs, drive long tasks — assume a
   platform team: Kubernetes, queues, Postgres, credential plumbing, on-call.
   Centaur, the system OpenTag's UX descends from, is exactly this: excellent
   product behavior on top of infrastructure only a staffed team can run.
   (Centaur is the internal predecessor system whose Slack UX OpenTag ported;
   see Appendix B.) The gap between "demo agent" and "agent your company can rely on" is mostly
   reliability engineering — deduplication, crash recovery, cancellation,
   delivery guarantees — that every in-house team ends up rebuilding badly.

3. **Security is bolted on.** Most agent deployments hand the model process
   long-lived credentials and hope the prompt holds. That is unacceptable the
   moment the agent can push code or spend money.

4. **Setup friction kills adoption.** Every additional step between "I want
   this" and "it answered its first question in our Slack" loses a large
   fraction of teams. Products that require cloning a repo, provisioning a
   database, and pasting six secrets do not spread inside companies; products
   that install like a Slack app do.

OpenTag's answer, layer by layer: the agent and harness solve (2) and (3) — the
reliability and security engineering is done once, in the open, on
infrastructure with near-zero idle cost. The platform layer solves (4). The
knowledge layer solves (1), and is the reason the product gets *better* the
longer a company runs it.

## 4. The four-layer architecture

The system is four layers. Each is useful without the ones above it, and each
becomes more valuable because of the ones below it.

```
Layer 4  KNOWLEDGE   memory, search, distillation across company activity   ← foundation + gated rollout
Layer 3  PLATFORM    provisioning, key custody, connectors, 1-click deploy  ← metadata foundation + activation gates
Layer 2  HARNESS     sandboxed execution engine (Claude Code compatible)    ← done
Layer 1  AGENT       Slack-native agent on Workers + Durable Objects       ← done
```

**Build order, stated plainly:** Layer 4's ingestion and retrieval foundation
and Layer 3's metadata contracts now coexist behind explicit gates. The current
sequence is to keep durable knowledge and actor authorization safe, deploy the
tenant-scoped credential/effect boundary, then expand source reconciliation and
router tiers only after their ACL, budget, quality, and rollback evidence is
complete. Worker Secrets configure deployment/bootstrap values; they are not a
per-tenant OAuth/token store.

### Layer 1 — Agent (done)

**What:** The production Slack surface. One Cloudflare Worker (`opentag-bot`)
terminates all Slack events, commands, and interactions. Durable Objects hold
the state that makes the agent trustworthy: `ConversationStateDO` (active-turn
and render fences, human-in-the-loop approvals, Stop continuations),
`SessionEventDO` (append-only execution event log and replay),
`WorkspaceConfigDO` (prompts, tool bundles, policies), and `KnowledgeDO`
(channel memory and the ingestion ledger).

**Status:** Shipped and hardened. Mentions, DMs, threads, slash commands,
quick actions, streaming incremental rendering within Slack's rate and block
limits, durable human approval that survives Worker isolate hops, a Stop
command that actually controls in-flight effects, and a "never-silent"
recovery contract: every turn ends in a visible answer, an explicit error, or
a confirmed cancellation — crashes included. A1–A5 of the implementation plan
are complete; the full suite (672/672 tests) passes.

**Why it matters:** This layer is the trust foundation. Nobody delegates real
work to an agent that double-posts, drops answers on crashes, or ignores
"stop." The exact-fence and obligation machinery here is the unglamorous 80%
of the work and the part in-house rebuilds always skip.

### Layer 2 — Harness (done)

**What:** The execution engine for work that needs a real computer: a
per-session Cloudflare Container that clones a repository, runs a coding CLI
(Claude Code natively; GPT models via the private Claudex proxy; Nanocodex),
and streams results back. The security model assumes the agent process is
hostile: internet disabled at the container boundary, HTTPS intercepted,
sentinel credentials inside the process, real credentials injected by the
outer Worker only after validating host, method, repo, branch, and operation.
Git pushes require a durable per-turn Slack approval; success is proven by
mechanical postconditions (new commit on the session branch, attributed PR
when approved), not by the model claiming it finished.

**Status:** Production-enabled, all three model backends sharing one sandbox,
Stop, and egress policy.

**Why it matters:** The harness is what separates "chatbot" from "coworker."
And its credential architecture — the model never holds a real secret — is the
pattern the whole platform layer generalizes: OpenTag's answer to agent
security is *the agent can't leak what it never had*.

### Layer 3 — Platform (foundation landed; activation remains gated)

**What:** Everything between "a company wants OpenTag" and "OpenTag is running
in their Slack." Four responsibilities:

1. **Provisioning.** A signup flow that creates a workspace's entire footprint
   — Durable Object namespaces, config, Slack app installation — from a single
   OAuth. Cloudflare DOs are created on first access with no infrastructure
   ceremony, which is precisely what makes per-tenant provisioning a code path
   rather than an ops runbook. (Section 5 describes the flow.)

2. **Key custody.** The platform generates and holds each workspace's agent
   identity and credentials. No raw private keys or API secrets are handed to
   users to paste and lose. Buzz — Block's Nostr-based community platform,
   which custodies community keypairs server-side — is the reference pattern:
   users get capabilities, the platform holds keys. This extends the harness's
   sentinel-credential model up a level: workspace admins grant and revoke
   capabilities; the platform owns the secret material, scoped per tenant,
   rotatable without user action. Self-hosters keep the escape hatch of
   supplying their own keys.

3. **Connector marketplace.** OpenTag speaks MCP. The platform turns "our
   agent should reach Linear / Notion / our internal API" into a browse-and
   -authorize experience: a curated registry of MCP servers, per-workspace
   OAuth, and admin-controlled tool bundles enforced by the existing
   `WorkspaceConfigDO` policy machinery. Connectors are also ingestion
   sources for Layer 4 — the K2 addendum in `KNOWLEDGE-BASE-SPEC.md` already
   defines wiki/code/custom-database source contracts.

4. **Billing and administration.** Usage metering, plan limits, and a minimal
   web console for the things Slack is bad at: connector auth, channel
   tracking policy, audit views.

**Status:** The metadata foundation is source-complete and synthetic-live:
provisioning receipts, identity/credential references, OAuth and marketplace
metadata, metering, memory governance, and effect leases are durable in
`PlatformStateDO`. The shared-fleet/per-team-DO decision is locked. What
remains is the tenant-scoped credential broker/effect worker, OAuth callback,
provider custody, billing/deletion execution, and any web/admin product surface
that is actually needed.

**Why it matters:** Layers 1–2 make a great product for one workspace operated
by its builder. Layer 3 makes it a company: the difference between "impressive
open-source project" and "thing a thousand teams run" is entirely in this
layer.

### Layer 4 — Knowledge (in progress; the moat)

**What:** A per-workspace knowledge index that turns company activity into
retrievable, cited memory. The design is specified in
`KNOWLEDGE-BASE-SPEC.md`: a Supermemory Local retrieval service (currently
planned as a single pinned service on Railway with one persistent volume) fed
exclusively through a Cloudflare Queue pipeline — Slack event → `KnowledgeDO`
ledger → Queue → consumer → index — with exact per-workspace tag isolation
(`workspace:{teamId}`), full-thread pagination-aware ingestion, revision
tracking, tombstones for deletions, and a bounded `search_slack` tool that
returns citations, never raw index output, and degrades safely when the index
is unavailable. Durable Objects remain the product-state spine; the index is a
sidecar that can be rebuilt, never the source of truth.

Beyond Slack threads, the K2 addendum extends the same ledger and queue to
wiki pages, code, and custom databases, then adds distillation (background
enrichment of raw activity into summarized, linkable knowledge), unified
cross-source search with rank fusion, "who knows about X" routing, and an MCP
endpoint that exposes the whole index to external agents.

**Status:** B0-side contracts, KnowledgeDO/ledger machinery, actor-bound
authorization, bounded query templates, and the Slack retrieval path are
source-complete. A live Slack retrieval passed, while reconciliation,
production source activation, backup/restore, and broad ingestion remain behind
the explicit B-series gates. Fresh indexing is eventually consistent.

**Why it's the long-term moat:** Layers 1–3 are excellent engineering, but
engineering gets copied. The knowledge layer produces something that cannot be
copied: months or years of a specific company's decisions, context, and
tribal knowledge, indexed with citations and access control, inside that
company's own deployment. Switching away from OpenTag after a year means
abandoning — or laboriously exporting — the thing that made the agent good.
Every day of use widens the gap between OpenTag-with-your-history and any
competitor starting cold. It also compounds across layers: better memory makes
the agent's answers better, which drives more usage, which produces more
memory. That loop, per-tenant and privacy-bounded, is the business.

The honest objection: the raw inputs (Slack history, wikis, repos) belong to
the customer, and the index is deliberately rebuildable from the ledger — so a
competitor could re-ingest the same sources. True. The defensible part is not
the raw corpus but everything above it: the distilled and curated layer built
up by months of actual agent use, the citation and access-control machinery
wired into daily workflows, the connectors already authorized, and the habit
loop of a team that asks the bot before pinging a human. Re-ingestion recovers
documents; it does not recover an installed, trusted, integrated system. That
is a switching *cost*, not a switching *impossibility* — which is why §9
measures the moat (retention, citation rates) instead of asserting it.

### 4.5 The request router — three-tier dispatch (decided 2026-07-31; shadow implemented)

The four layers say what the system *can* do. The router decides, per request,
*which* of those capabilities a given Slack message or API call actually
engages — before any execution starts. It is a cross-cutting component, not a
fifth layer: a lightweight classification stage at ingress (a stateless
Worker path, deliberately not a Durable Object) that routes every incoming
request to one of three execution tiers. `ROUTER-SPEC.md` is the authoritative
spec; this section states the model and why it exists.

```
                        ┌─ Tier 1  KB DISPATCH       sub-2s, near-zero cost
Slack / API ─▶ ROUTER ──┼─ Tier 2  AGENT DISPATCH    seconds, moderate cost
                        └─ Tier 3  SANDBOX DISPATCH  minutes–hours, higher cost
```

**Tier 1 — KB dispatch.** Questions answerable directly from the Layer 4
knowledge index (Supermemory hybrid search, per `KNOWLEDGE-BASE-SPEC.md`) are
answered without spawning an agent session at all: retrieve, re-rank, cite,
reply. The design reference is Cerebras's internal KB — 15k+ queries/day
across Slack/GitHub/Jira/Docs served from a single Postgres table of
embeddings plus metadata, with fast inference re-ranking 20+ chunks in under
500ms. The lesson OpenTag takes from it is the *narrow waist*: one simple
retrieval store, one dispatch path, no per-question agent machinery. Tier 1
should handle the majority of request volume, which is what makes the
platform's unit economics work — most questions cost close to nothing.

**Tier 2 — agent dispatch.** What OpenTag does today: a stateful Durable
Object session for multi-turn tasks, drafts, analysis, tool use, and MCP
connectors. Layer 1's fences, obligations, and approvals all live here.

**Tier 3 — sandbox dispatch.** Long-running code execution, complex
workflows, multi-step builds — work measured in minutes to hours. This is the
current gap in the platform: the Layer 2 harness runs per-session coding
containers, but there is no first-class path for long-duration, multi-step
sandbox work dispatched from a Slack message. The decision: **Cloudflare
Containers (beta) is the primary Tier 3 substrate, with E2B as the documented
fallback.** Why: Containers keep Tier 3 inside the same platform, billing,
tenancy, and security model as everything else, and the harness's sandbox and
sentinel-credential contract already runs on them. Why E2B as fallback:
Containers just shipped in beta, and a beta dependency needs a named exit
(§10.13). And explicitly: **OpenTag will not build a custom sandbox
orchestrator.** That is the Kubernetes path Centaur took and the one thing
this project was designed to escape; a bespoke fleet of long-running compute
would quietly reintroduce the ops team the §7 bet eliminates.

Why the router matters strategically: without it, every request pays Tier 2
cost and latency, and Tier 3 work has no home. With it, the knowledge moat
(Layer 4) gets a direct product surface — instant cited answers — and the
pricing model gets a natural shape (Tier 1 included, Tier 2 metered, Tier 3
premium; see `ROUTER-SPEC.md` §6). The router's classification accuracy and
the Tier 3 cost model are open questions (§10.12, §10.14).

## 5. The one-click deploy experience

The target onboarding, end to end, in under five minutes (the §9 acceptance
gate is a looser ten, measured on strangers):

1. **Visit the site, click "Add to Slack."** Standard Slack OAuth. The user
   is a workspace admin; no CLI, no repo clone, no config file.
2. **Provisioning runs during the OAuth redirect.** The platform Worker
   creates the workspace's tenancy — DO namespace entries keyed by `teamId`,
   default config, generated and custodied agent credentials — and registers
   the bot in the workspace. Because DO tenancy is per-key rather than
   per-deployment, this is milliseconds of code, not minutes of
   infrastructure. This is the payoff of being Cloudflare-native: the same
   act that would be "spin up a cluster" elsewhere is "derive a Durable
   Object ID" here.
3. **Guided first contact in Slack.** The bot posts a short onboarding DM:
   write a clear question or request in a thread (tagging is optional); here's
   how approvals work; here's how to stop it. First useful answer within the
   first minute.
4. **Progressive capability grants.** Connectors (Linear, GitHub, Notion, a
   repo for the coding harness), channel knowledge-tracking, and model
   preferences are added later, each behind its own explicit admin
   authorization — mirroring the spec's rule that unconfigured channels
   ingest nothing and undeclared hosts are unreachable. Nothing is on by
   default that touches data or the outside world.

The mental model is Vercel's: Vercel made "deploy a Next.js app" a git-push
instead of a DevOps project, and won the framework by owning the deploy
moment. OpenTag makes "deploy a company agent" a Slack OAuth instead of an
infrastructure project. The self-host path (own Cloudflare account,
`wrangler`, own keys) remains fully supported and documented; the hosted flow
is the same system with the platform doing the operator's job.

Why this matters strategically: the deploy moment is where the funnel dies for
every competitor that ships a repo instead of a button. It is also where key
custody naturally lives — the user never sees a secret because the flow never
needs to show them one.

## 6. Claude Code compatibility

**The decision:** Claude Code compatibility is a *distribution strategy*, not
an architectural constraint. OpenTag speaks the protocols of the Claude Code
ecosystem — MCP above all — so that the fastest-growing population of agent
power users can plug OpenTag in with zero friction. OpenTag does not try to
*be* Claude Code, track its internals, or fork its harness.

Concretely, compatibility means three things:

1. **OpenTag consumes MCP.** Any MCP server someone built for Claude Code —
   and there are thousands — is a candidate OpenTag connector. The connector
   marketplace inherits an ecosystem instead of building one.
2. **OpenTag runs Claude Code.** The harness executes the stock Claude Code
   CLI in its sandbox (and, through the same sandbox, GPT-backed and Nanocodex
   modes). Skills, prompts, and habits users developed locally transfer to
   the team agent unchanged. Model backends stay swappable; OpenTag's value
   is the surface, custody, and memory around the model, not the model.
3. **OpenTag serves MCP.** The knowledge layer's planned `/mcp/knowledge`
   endpoint means a developer's local Claude Code session can query the
   company's OpenTag memory. The company brain becomes a tool in every
   employee's personal agent — a second distribution channel that costs one
   endpoint.

What this unlocks: ecosystem leverage in both directions (their tools work in
our product; our product is a tool in theirs), a zero-education adoption path
for the exact developers who champion tools inside companies, and insulation
from model-vendor churn. What it forecloses: very little. The genuine dependencies are the Claude Code CLI
itself in one harness mode and MCP as a protocol bet; but because harness
modes are already plural (Claude Code, Claudex, Nanocodex share one sandbox
contract), OpenTag can adopt whatever execution engine wins next while keeping
the same surface, custody, and memory contracts.

## 7. Why Cloudflare specifically

This is a locked decision (`DECISIONS.md`), and the reasoning matters because
it is the load-bearing wall under Layers 3 and 4's economics:

- **Durable Objects are the tenancy model.** One DO per workspace per concern,
  created on first access, strongly consistent, globally addressable. Per-
  tenant isolation — the hardest part of any multi-tenant agent platform — is
  a property of the runtime, not a subsystem we build. This is what makes
  one-click provisioning a code path.
- **Zero idle cost.** Workers and DOs cost nothing while a workspace is
  quiet. A platform hosting thousands of small workspaces, most idle at any
  moment, is economically viable in a way a pod-per-tenant or
  database-per-tenant design is not.
- **No operations team required.** No clusters, no node upgrades, no
  capacity planning. This is what keeps the self-host promise honest: a solo
  operator genuinely can run production OpenTag, because we do it the same
  way.
- **Containers close the compute gap.** The one thing edge isolates can't do
  — run a real coding CLI against a real checkout — Cloudflare Containers do,
  per-session, inside the same platform and security model.
- **The constraints were good for us.** Workers forbid Socket Mode and
  long-lived in-memory state; being forced to make every turn durable,
  addressable, and recoverable produced the reliability contract that is now
  the product's core trust claim.

The honest caveat: the knowledge index itself is currently specced to run on
Railway, because Supermemory Local needs a persistent single-node volume that
Workers don't offer. That is a deliberate, contained exception — one sidecar
service, rebuildable from the DO ledger, never in the Slack turn path — and
collapsing it back into Cloudflare when the primitives allow is an open
question (§10), not an abandoned principle.

## 8. Competitive positioning

**Versus "just a Slack bot" (including building one in-house):** A weekend
Slack bot is a webhook and an API call. OpenTag is what that bot becomes after
someone spends a year on the failure modes: exact once-per-event turn
admission under Slack's redelivery behavior, crash recovery that never leaves
a silent thread, a Stop that wins races against in-flight side effects,
durable approvals that survive isolate hops, rate-limited streaming that
respects Block Kit's real limits, and a sandboxed execution plane that never
holds a real credential. Teams that build in-house rebuild this list one
incident at a time. OpenTag's pitch to the build-vs-buy meeting is the gap
audit and the test suite, in the open.

**Versus general AI assistants (ChatGPT, Claude.ai, Copilot chat):** They are
personal, stateless, and elsewhere. OpenTag is organizational, cumulative, and
inside the room where work happens. It doesn't ask users to bring context to
the tool; it lives where the context is generated and keeps it.

**Versus Slack AI:** Slack AI summarizes and searches Slack. It does not
execute — no code, no tickets, no research plane, no connectors to your
systems — and its memory is Slack's feature, not your asset. OpenTag treats
Slack as a surface, not the boundary of the product.

**Versus agent platforms (Dust, Glean, LangChain-style stacks, Devin et al.):**
Closest competitors, three real differentiators: (1) **deploy-and-own** —
open source, one-click hosted *or* self-hosted on your own Cloudflare account,
versus SaaS-only black boxes; (2) **the execution trust stack** — worker-
enforced egress, sentinel credentials, HITL-gated writes, and mechanical
success postconditions, versus "the model has our API keys"; (3) **per-tenant
compounding memory** with exact isolation and citations, versus retrieval
bolted onto a stateless assistant.

**Versus Conductor (Melty Labs) and local agent orchestrators:** Conductor is
a Mac app that orchestrates parallel Claude Code / Codex agents in isolated
git worktrees — each agent gets its own branch, transcript, and review flow,
and its recent multiplayer release adds shared visibility. It is the best
argument that *orchestrated parallel agent work* is a real product category.
Its structural limits are the differentiator: Conductor is Mac-only,
developer-only, and local — the orchestration lives on one person's laptop,
and only people who run the app can trigger or see the work. OpenTag's Tier 3
(§4.5) is the same category made cloud-native, multi-tenant, and
Slack-native: anyone in the org — PM, support lead, founder — can trigger
long-running build-and-verify work with a Slack message, without knowing what
runs underneath, and the session, approvals, and results are durable company
state rather than artifacts on a laptop. Conductor multiplies one
developer; OpenTag gives the whole organization the button.

**Versus Centaur (the lineage, not a market competitor):** OpenTag ported Centaur's UX discipline —
streaming conflation, render obligations, Stop semantics, session logs — and
deliberately left behind its Kubernetes/Rails/Postgres control plane
(~`docs/centaur-port.md`). Same product taste, an operational footprint one
person can run, and a deployment story Centaur structurally cannot offer.

The one-line answer to "what makes this different": **others sell an
assistant; OpenTag installs an employee that never forgets and that you
actually own.**

## 9. What success looks like

Concrete, checkable, no adjectives. Model costs are assumed to keep falling;
the metrics that matter are retention and memory usage, because they measure
the moat directly.

**6 months (Q1 2027):**
- Knowledge layer live in production: the B-series gates through one-channel
  canary and scoped backfill (B8) passed; `search_slack` answering with
  citations in daily use in at least 5 external (non-Will) workspaces.
- Platform MVP: a stranger can go from the website to a working bot in their
  Slack in under 10 minutes with zero support contact; at least 20 workspaces
  have done so.
- Key-custody design (§10.4) decided, written down, and implemented for
  hosted workspaces — no hosted user has ever been shown a raw key. (The
  design is a prerequisite deliverable, not an assumption.)
- Test and reliability bar held: suite green, zero known silent-drop incidents
  across hosted workspaces.

**12 months (mid-2027):**
- 200+ active workspaces (agent used on 3+ days/week), ≥40% of them retained
  past 90 days.
- Connector marketplace live with ≥15 curated MCP connectors; median active
  workspace has ≥2 connectors authorized.
- Multi-source knowledge (K2): at least wiki + code ingestion shipped behind
  the same ledger; ≥30% of answered questions in active workspaces cite
  workspace knowledge rather than model-only output.
- `/mcp/knowledge` shipped: OpenTag memory queryable from users' own Claude
  Code sessions.
- Router live in production: every request classified and tier-tagged, with
  a measured Tier 1 hit rate ≥40% of request volume in active workspaces and
  misroute corrections (user escalations of a Tier 1 answer) under the
  accuracy bar set by resolving §10.12 — working number <10%, to be
  validated against real dispatch data before it hardens into a target.
- Tier 3 shipped on Cloudflare Containers: at least one long-running
  (>10-minute) sandbox workflow triggerable from a Slack message, with the
  E2B fallback path documented and tested.
- Revenue exists: a priced hosted tier with ≥25 paying workspaces, unit
  economics per workspace measured and published internally.
- ≥10 external contributors with merged PRs (the self-host community is alive).

**24 months (mid-2028):**
- 1,000+ active workspaces; the median 12-month-old workspace's knowledge
  index answers the majority of "how do we / where is / who knows" questions
  without a human being pinged — the measurable form of "brain of the
  company."
- Churned-workspace exit interviews cite knowledge loss as a top switching
  cost (the moat is observable, not asserted).
- Tier 1 handles the majority (>60%) of request volume in mature workspaces
  at near-zero marginal cost — the router-measured form of "the knowledge
  layer answers before an agent is needed" — and per-tier cost accounting is
  accurate enough to price plans from (see §10.14).
- The platform runs with less than one full-time person on operations —
  proof that the Cloudflare bet holds at fleet scale.
- Default-alive financially, or a deliberate, funded decision not to be.
- At least one additional surface (e.g. Teams or a web client) either shipped
  on the unchanged Layer 1–2 contracts or explicitly rejected in an updated
  version of this document.

If, at 24 months, workspaces are numerous but the knowledge-citation and
retention numbers are flat, the moat thesis is wrong and the honest move is to
reposition as a best-in-class Slack agent — that decision point is part of
this vision, not a footnote.

## 10. Open questions

Genuinely undecided. Each needs an owner and a decision date; none should be
resolved silently by implementation drift.

1. **Hosted multi-tenancy shape.** One shared production Worker fleet with
   per-`teamId` DO isolation, or Workers-for-Platforms style per-tenant
   dispatch (stronger blast-radius isolation, more moving parts)? Affects key
   custody, billing metering, and noisy-neighbor policy. Must be decided
   before the platform MVP.
2. **Knowledge index residency.** The Railway/Supermemory single-node design
   is specced and gated, but it is a per-fleet service in a per-tenant world.
   Does the hosted platform run one index per workspace (cost), a shared
   index with tag isolation (trust — tags are currently the *only* boundary),
   or wait/build for a Cloudflare-native or per-DO retrieval primitive?
   Related: is application-layer encryption of corpus content required before
   hosting third-party data at all (the spec explicitly flags this as
   unverified)?
3. **Business model boundary.** What exactly is open source versus hosted-only?
   (Likely: all four layers' code open, custody + marketplace curation +
   operations are the paid product — but this is not decided.) Also
   unresolved: model-cost pass-through vs. bundled pricing, and whether
   customers bring their own Anthropic/OpenAI keys on the hosted tier.
4. **Key custody implementation.** Buzz is the pattern reference, but the
   concrete design — where secret material lives (Workers Secrets? per-tenant
   DO-wrapped envelopes? external KMS?), rotation policy, and what an
   auditable custody log looks like — is unwritten. Prerequisite for hosting
   anyone else's credentials.
5. **Slack Marketplace listing.** Distribution through Slack's app directory
   would supercharge one-click adoption but imposes Slack's review regime,
   scope constraints, and data-handling attestations. Pursue at MVP or after
   product-market fit?
6. **Connector marketplace trust model.** Curated-only registry, or
   third-party submissions? An MCP server is arbitrary code with data access;
   a marketplace implies a vetting, sandboxing, and revocation story we have
   not designed.
7. **Memory governance.** Retention windows, per-channel opt-out, deletion
   guarantees beyond tombstones, admin visibility into what the index holds,
   and what happens to knowledge when an employee or a workspace leaves.
   Compliance posture (SOC 2 timeline) hangs off this.
8. **Distillation quality bar.** Raw-thread retrieval is specced; the
   distillation layer (summaries, decision extraction, who-knows routing) has
   stubs but no quality metric. What is the acceptance test for "the
   distilled answer is trustworthy enough to cite"?
9. **Name and brand.** "OpenTag" describes the Layer 1 interaction (tag the
   bot). Whether it stretches to name a company operating system — or the
   platform ships under a different name — is an open branding question.
10. **Second surface timing.** The layers below Slack are surface-agnostic by
    design, but every month spent on a second surface is a month not spent on
    the knowledge moat. Explicit criteria for when (or whether) to add one
    are undefined.
11. **Resourcing.** The §9 targets are not achievable solo. Raise, bootstrap
    from early hosted revenue, or recruit open-source co-maintainers first?
    This decision gates the realism of every date in §9 and should be made
    before the platform MVP is scheduled.
12. **Router classification accuracy.** The three-tier model (§4.5) only
    works if the classifier is right often enough: a Tier 1 misroute gives a
    confidently wrong-scope answer; a Tier 3 misroute burns real money.
    What accuracy is acceptable, how is it measured (user escalations?
    sampled audits?), and what does the correction loop look like when the
    router gets it wrong? `ROUTER-SPEC.md` §8 carries the detailed version.
13. **Cloudflare Containers beta risk.** Tier 3's primary substrate is a
    beta product. Undecided: what pricing, limits, region coverage, or
    max-duration changes at GA would force the E2B fallback; what the
    trigger criteria for switching are; and who owns tracking the beta's
    evolution. The no-custom-sandbox rule is locked; the *vendor* under
    Tier 3 is not.
14. **Tier 3 cost model.** Minutes-to-hours of container compute per request
    is a different cost class from anything OpenTag has priced. Metered
    pass-through, bundled premium-tier allowance, per-job quotes with
    approval, or admin-set budgets? Interacts with §10.3 (business model)
    and must be decided before Tier 3 is enabled for hosted workspaces.

---

## Appendix A: how to read the rest of the repo

- `PRODUCT.md` — the current product contract (Layer 1–2 behavior, hard
  invariants).
- `ARCHITECTURE.md` — implemented topology, state machines, and the harness
  security boundary.
- `DECISIONS.md` — locked technical decisions; do not relitigate casually.
- `KNOWLEDGE-BASE-SPEC.md` — the authoritative Layer 4 execution plan
  (B0–B9 phases, stop gates, K2 multi-source addendum).
- `ROUTER-SPEC.md` — the request router / three-tier dispatch spec (§4.5's
  authoritative expansion: classification model, fallbacks, observability,
  pricing mapping).
- `docs/centaur-port.md` — what was inherited from Centaur and what was
  deliberately left behind.
- `goal-outputs/opentag-2-gap-audit/gap-audit.md` — the skeptical audit of
  implementation vs. spec; the honest list of remaining rough edges.
  ("Hardened" in §4 means the reliability contract holds and the suite is
  green, not that this list is empty — the audit's open items are known
  regressions like attachment handling, not silent-failure classes.)

## Appendix B: vocabulary

Project and ecosystem terms this document uses, defined once for newcomers.

**People, projects, and vendors**

- **Centaur** — an internal predecessor Slack-agent system (Rails + Postgres +
  Kubernetes) whose *UX behavior* OpenTag studied and reimplemented on
  Cloudflare. It is a read-only reference codebase, not a shipping competitor.
  `docs/centaur-port.md` is the exact inventory of what was ported and what
  was deliberately dropped.
- **Claude Code** — Anthropic's agentic coding CLI. OpenTag's harness runs the
  stock binary in its sandbox; OpenTag also speaks its ecosystem's protocol
  (MCP) in both directions.
- **MCP (Model Context Protocol)** — the open protocol for exposing tools and
  data sources to AI agents. "Connector" in this document means an MCP server.
- **Claudex** — OpenTag's private proxy Worker + container
  (`opentag-claudex-proxy`) that lets the Claude Code CLI run against GPT
  models via CLIProxyAPI and Codex OAuth. Operated by this project, not an
  external service.
- **Nanocodex** — a third harness mode: a native OpenAI-Responses coding CLI
  run in the same sandbox with a Worker-injected API key.
- **Buzz** — Block's Nostr-based community messaging platform (Nostr is a
  keypair-identity protocol). Relevant here for exactly one pattern: Buzz
  generates and custodies community keypairs server-side so users never
  handle raw keys. That custody pattern, not the product, is the reference.
- **Supermemory Local** — a self-hostable retrieval/memory server (pinned
  release, single process) that provides the embedding, indexing, and hybrid
  search under Layer 4. It needs a persistent local volume, which Workers
  don't offer — hence Railway.
- **Railway** — a container-hosting PaaS; chosen pragmatically as the one
  non-Cloudflare service, solely to run Supermemory Local on a persistent
  volume. See §7's caveat and §10.2.
- **Conductor** — Melty Labs' Mac app that orchestrates parallel Claude Code
  / Codex agents in isolated git worktrees, with per-agent branches,
  transcripts, and review flow (recently multiplayer). Relevant as the
  local/developer-only counterpoint to OpenTag's cloud-native Tier 3 (§8).
- **Cerebras KB pattern** — the design reference for Tier 1: Cerebras's
  internal knowledge base serves 15k+ queries/day across Slack, GitHub,
  Jira, and Docs from a single Postgres table of embeddings + metadata,
  re-ranking 20+ chunks in <500ms. The takeaway is the narrow-waist
  retrieval architecture, not the specific stack.
- **E2B** — a hosted sandbox-as-a-service for running agent code; the
  documented fallback substrate for Tier 3 if Cloudflare Containers' beta
  terms shift (§10.13).
- **Durable Object (DO)** — Cloudflare's strongly consistent, single-threaded,
  globally addressable stateful primitive; created on first access by key.
  OpenTag keys them per Slack workspace/thread, which is the entire tenancy
  model.

**Project machinery**

- **Active-turn / render / effect fences** — compare-and-set claims in
  `ConversationStateDO` that ensure, per thread, only one execution can post
  output or fire a side effect at a time, and that Stop can win races against
  in-flight work.
- **Render obligation** — a durable record, written before a turn executes,
  that says "this thread is owed a visible outcome." An alarm-driven recovery
  path replays or errors any obligation left unfulfilled by a crash. This is
  the mechanism behind the "never-silent" claim.
- **Sentinel credentials** — fake placeholder secrets given to the sandboxed
  agent process; the outer Worker swaps in real credentials only on validated,
  allowlisted outbound requests. The model never possesses a real key.
- **HITL** — human-in-the-loop: durable Slack approval cards (e.g. for git
  pushes) whose clicks survive Worker isolate changes.
- **A1–A5** — the completed phases of the core implementation plan
  (agent + harness). **B0–B9** — the gated phases of the knowledge-layer plan
  in `KNOWLEDGE-BASE-SPEC.md`. **K2** — that spec's addendum extending
  ingestion beyond Slack to wikis, code, and custom databases.
- **Stop gate** — a named point in the B-series where work halts until an
  operator explicitly approves an external mutation (deploy, secret, backfill).
- **Tombstone** — a durable "this document was deleted" marker that prevents
  retries from resurrecting removed content in the index.
- **Rank fusion (RRF)** — merging ranked result lists from multiple search
  sources into one ordering; planned for K2 unified search.
- **Router / dispatch tiers** — the ingress classification stage (§4.5) that
  routes each request to Tier 1 (KB dispatch: answer from the knowledge
  index, no agent session), Tier 2 (agent dispatch: a DO-backed agent turn),
  or Tier 3 (sandbox dispatch: long-running container work). Specified in
  `ROUTER-SPEC.md`.
- **Default-alive** — Paul Graham's term: on current growth and spending, the
  company reaches profitability before running out of money.
