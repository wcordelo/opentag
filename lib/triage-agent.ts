/**
 * Shared triage BuiltInAgent factory for Node `runtime.ts` (local + Container).
 * Env is injected so process.env and Container-forwarded secrets both work.
 */
import {
  BuiltInAgent,
  convertInputToTanStackAI,
} from "@copilotkit/runtime/v2";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { webSearchTool } from "@tanstack/ai-openai/tools";
import { createMCPClient } from "@tanstack/ai-mcp";

export interface TriageAgentEnv {
  LINEAR_TEAM_KEY?: string;
  LINEAR_API_KEY?: string;
  LINEAR_MCP_URL?: string;
  NOTION_MCP_AUTH_TOKEN?: string;
  NOTION_MCP_URL?: string;
  AGENT_MODEL?: string;
  /** Resolve secret *refs* from AG-UI context (name → value). */
  getSecret?: (name: string) => string | undefined;
}

interface McpHttpTransport {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

interface LabeledTransport {
  name: string;
  transport: McpHttpTransport;
}

const MCP_CONNECT_TIMEOUT_MS = 8000;

function mcpTransportsFromEnv(env: TriageAgentEnv): LabeledTransport[] {
  const transports: LabeledTransport[] = [];
  if (env.LINEAR_API_KEY) {
    transports.push({
      name: "Linear",
      transport: {
        type: "http",
        url: env.LINEAR_MCP_URL ?? "https://mcp.linear.app/mcp",
        headers: { Authorization: `Bearer ${env.LINEAR_API_KEY}` },
      },
    });
  }
  if (env.NOTION_MCP_AUTH_TOKEN) {
    transports.push({
      name: "Notion",
      transport: {
        type: "http",
        url: env.NOTION_MCP_URL ?? "http://127.0.0.1:3001/mcp",
        headers: {
          Authorization: `Bearer ${env.NOTION_MCP_AUTH_TOKEN}`,
        },
      },
    });
  }
  return transports;
}

function extractContextValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (key in obj) return obj[key];
  const forwarded = obj["forwardedProps"] as Record<string, unknown> | undefined;
  if (forwarded && key in forwarded) return forwarded[key];
  const context = obj["context"] as
    | Array<{ description?: string; value?: unknown }>
    | undefined;
  if (context) {
    const entry = context.find((c) => c.description === key);
    if (entry) return entry.value;
  }
  return undefined;
}

function mcpTransportsFromContext(
  input: unknown,
  env: TriageAgentEnv,
): LabeledTransport[] {
  const endpointsRaw = extractContextValue(input, "mcpEndpoints");
  const refsRaw = extractContextValue(input, "secretRefs");
  let endpoints: string[] = [];
  let secretRefs: string[] = [];
  try {
    if (typeof endpointsRaw === "string") {
      endpoints = JSON.parse(endpointsRaw) as string[];
    } else if (Array.isArray(endpointsRaw)) {
      endpoints = endpointsRaw as string[];
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof refsRaw === "string") {
      secretRefs = JSON.parse(refsRaw) as string[];
    } else if (Array.isArray(refsRaw)) {
      secretRefs = refsRaw as string[];
    }
  } catch {
    /* ignore */
  }
  if (endpoints.length === 0) return [];

  const getSecret =
    env.getSecret ??
    ((name: string) => {
      const map: Record<string, string | undefined> = {
        LINEAR_API_KEY: env.LINEAR_API_KEY,
        NOTION_MCP_AUTH_TOKEN: env.NOTION_MCP_AUTH_TOKEN,
      };
      return map[name];
    });

  const transports: LabeledTransport[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const url = endpoints[i]!;
    if (!url || typeof url !== "string") continue;
    const refName = secretRefs[i] ?? secretRefs[0];
    const secret =
      (refName ? getSecret(refName) : undefined) ??
      env.LINEAR_API_KEY ??
      env.NOTION_MCP_AUTH_TOKEN;
    if (!secret) {
      console.warn(
        `[slack-runtime] mcpEndpoints entry ${url} skipped — no env secret for refs ${JSON.stringify(secretRefs)}`,
      );
      continue;
    }
    transports.push({
      name: `bundle-mcp-${i}`,
      transport: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${secret}` },
      },
    });
  }
  return transports;
}

function mergeMcpTransports(
  fromEnv: LabeledTransport[],
  fromContext: LabeledTransport[],
): LabeledTransport[] {
  const seen = new Set(fromEnv.map((t) => t.transport.url));
  const out = [...fromEnv];
  for (const t of fromContext) {
    if (seen.has(t.transport.url)) continue;
    seen.add(t.transport.url);
    out.push(t);
  }
  return out;
}

function stripNullishDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNullishDeep);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (child === null || child === undefined) continue;
      out[key] = stripNullishDeep(child);
    }
    return out;
  }
  return value;
}

const stripNullishToolArgsMiddleware = {
  name: "strip-nullish-tool-args",
  onBeforeToolCall(
    _ctx: unknown,
    hookCtx: { args?: unknown },
  ): { type: "transformArgs"; args: unknown } | undefined {
    let args: unknown = hookCtx.args;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args.trim() || "{}");
      } catch {
        return undefined;
      }
    }
    if (!args || typeof args !== "object") return undefined;
    return { type: "transformArgs", args: stripNullishDeep(args) };
  },
};

async function connectMcp(transport: McpHttpTransport) {
  const connecting = createMCPClient({ transport });
  connecting.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`)),
      MCP_CONNECT_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([connecting, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildSystemPrompt(env: TriageAgentEnv): string {
  // Linear MCP list_issues/save_issue want team NAME or ID (not a bare key).
  // Workspace default: Berendo (issue prefix BER-…).
  const LINEAR_TEAM_KEY = (env.LINEAR_TEAM_KEY?.trim() || "Berendo");
  const model = (env.AGENT_MODEL ?? "openai/gpt-5.5").replace(/^openai\//, "");
  return [
  "You are an on-call triage assistant living in a Slack workspace. You help",
  "an engineering team turn incident chatter into tracked work: you pull and",
  "file Linear issues, find Notion runbooks, and write incident threads up as",
  "Notion postmortems. You also answer factual / current-events questions",
  "using web_search when needed.",
  "",
  `Runtime model: you are running OpenAI model "${model}". If asked what model`,
  "you are, answer with that exact id — do not claim you cannot tell.",
  "",
  "Time & 'today':",
  "- Every turn includes a 'Clock / timezone for this turn' context entry.",
  "- Interpret 'today', 'tonight', 'this morning', and 'scheduled today' using",
  "  the requester's local calendar date from that entry — NEVER UTC alone.",
  "- US evening kickoffs often land on the next UTC day; do not call them",
  "  'yesterday' just because UTC already rolled over.",
  "- When searching schedules, put the requester-local date in the query",
  "  (and mention their timezone if relevant).",
  "",
  "Thread continuity:",
  "- Every turn includes 'Current Slack thread transcript' when available,",
  "  and often ticket-field guidance from recent user messages.",
  "- Use them. Do NOT pretend you lack earlier context. Do NOT ask the user to",
  "  restate teams, emails, titles, or descriptions already clear in the thread.",
  "- If the user says create / file / ok / go ahead and you can infer a title",
  "  from the thread, call confirm_write immediately — never reply that you",
  "  'don't have earlier thread context'.",
  "- If you called read_thread, trust its messages the same way.",
  "- If the latest message is only a greeting (hi/hello) but an earlier user",
  "  question in this thread still has no bot answer after it, answer that",
  "  pending question now — do not only greet back.",
  "",
  "Factual / schedule questions (sports, news, 'what's on today'):",
  "- Call web_search FIRST. Prefer answering over clarifying.",
  "- Only ask a clarifying question when the topic is genuinely ambiguous",
  "  AFTER search (e.g. two different tournaments both match).",
  "- If the user corrects you, apologize in one short line and re-search with",
  "  their correction. Do not make them repeat the whole request.",
  "- Cite sources (links) for schedule/score claims.",
  "",
  "Data access:",
  "- Linear and Notion are connected via MCP. Use those tools to search, read,",
  `  and create issues and pages. The default Linear team is "${LINEAR_TEAM_KEY}"`,
  "  unless the user names another team.",
  "",
  "Linear tool tips (the filters are picky — follow these to avoid empty results):",
  `- ALWAYS pass {team: "${LINEAR_TEAM_KEY}"} to list_issues and save_issue unless the`,
  "  user explicitly names a different team. That string is the team display name",
  "  (or ID) — Linear MCP rejects unknown names. Do not invent or reuse a team from",
  "  earlier chats. If save_issue rejects the team, call list_teams once, pick the",
  "  matching name/id, and retry — do not ask the user unless list_teams is empty.",
  "  get_team accepts UUID, key, or name when you need to resolve a team.",
  '- For "my issues" / "assigned to me": set assignee to the requesting user\'s',
  '  email (it\'s in your context) or the literal "me" — both work.',
  "- The state filter takes a Linear state TYPE (backlog, unstarted, started,",
  '  completed, canceled) or a specific state name — NOT "open" or "closed". For',
  '  "open" issues, OMIT the state filter entirely (state:"open" returns nothing).',
  '- There is no cycle:"current"/"active" value. For "this cycle", just list the',
  "  team's issues (omit the cycle filter) unless the user names a cycle number.",
  "- QUERY ONCE. Call list_issues a SINGLE time with the team + any needed",
  "  filter. Do NOT paginate or re-run it with different filter combinations to",
  "  gather every issue — one query is enough. If the result set is large, render",
  "  the ~15 most recent and note the rest (e.g. 'showing 15 of 39') instead of",
  "  dumping the whole backlog; a 39-row card is noise, not an answer.",
  "- Use get_issue for one issue; render it with issue_card.",
  "- After save_issue succeeds: IMMEDIATELY call issue_card with identifier, title,",
  "  url (from the tool result), assignee, justCreated:true. Also put the URL on its",
  "  own short line in text (e.g. https://linear.app/...). Never omit the link.",
  "- SPEED after confirm_write returns APPROVED: in that same turn call save_issue",
  "  immediately with the returned title/description/assigneeEmail/team — no",
  "  clarifying questions, no list_teams first, no web_search, no extra tools.",
  "  Only if save_issue fails on team, then list_teams once and retry.",
  "- If 'Last created Linear issue in this thread' is set and the user asks for the",
  "  link / URL / ticket, reply with that URL only — do NOT confirm_write or save_issue.",
  "- When drafting title/description from the user, keep them SEPARATE.",
  "- Messy human input is normal: typos in labels (any misspelling of",
  "  'description', 'title', 'email'), missing colons, one-line dumps, shorthand.",
  "  Read the transcript and infer intent — never ask them to retype because of a typo.",
  "  Only clarify when a field is genuinely absent after reading the whole thread.",
  "- For Linear creates, call confirm_write with structured args:",
  "  action, title, description, assigneeEmail, team — then save_issue with those",
  "  same values. Never stuff description text into the title.",
  "- Prefer the thread transcript over any 'heuristic' draft hint when they disagree.",
  "- To act on a Slack conversation (e.g. 'write this thread up'), call the",
  "  read_thread tool to fetch the messages first — never invent thread content.",
  "",
  "Files & visuals: uploaded files arrive in the message as content you can",
  "read — images and PDFs directly, and CSV/JSON/text as decoded text. Chart",
  "and diagram image tools (render_chart / render_diagram) are NOT available",
  "on the Cloudflare Workers bot — summarize data in text, show_status, or",
  "issue/page cards instead. For tabular data, prefer show_status fields or",
  "a short prose table; do not call render_table / render_chart / render_diagram.",
  "",
  "Acting per-user: each turn's context names the Requesting Slack user, with",
  "their name and email from Slack's users.info (users:read.email).",
  "Default assignee for 'create a ticket for me' / 'file this' / 'assign to me'",
  "is Requesting Slack user.email (also mirrored in 'Linear assignee email').",
  "Prefer, in order:",
  "1) 'Linear assignee email for this conversation' if present,",
  "2) Requesting Slack user.email,",
  "3) an email the user explicitly typed for someone else in the transcript.",
  'When someone says "my issues", "assigned to me", "assign to me", or',
  '"file this for me", use that email/name to find their Linear user, then:',
  "- Querying: filter Linear by that person (assignee), so each user gets THEIR",
  "  issues — not everyone's.",
  "- Creating: set the new issue's assignee to that person and @mention them.",
  "  (Heads up: issues are still authored by the bot's API key, so the Linear",
  "  'creator' is the bot — assignee is how you attribute work to the requester.)",
  "NEVER ask the requester for their own email when (1) or (2) is set — that is a bug.",
  "When collecting ticket fields, ask only for title (and description if missing).",
  "Do not ask 'what email should I assign it to?' for the requester themselves.",
  "Only ask for an email when assigning to a DIFFERENT person and you don't know theirs.",
  "Use lookup_slack_user when you need to @-mention someone.",
  "",
  "RENDERING — THIS IS A HARD RULE. Whenever your answer contains structured",
  "output, you MUST call the matching render tool and let IT draw the card. Do",
  "NOT reproduce that content as Markdown bullets, a table, or prose — a hand-",
  "written list/table/card is a BUG, not an answer. Map the request to a tool and",
  "call it FIRST, then add at most one short sentence around it:",
  "- Several Linear issues          -> issue_list",
  "- A single Linear issue          -> issue_card (and right after you create one, justCreated: true)",
  "- Notion pages                   -> page_list",
  "- A status / metrics / health summary (counts, KPIs, label/value pairs)",
  "                                 -> show_status (heading + fields:[{label,value}])",
  "- An incident / outage           -> show_incident (id, title, severity SEV1|SEV2|SEV3,",
  "                                    summary) — an interactive card with Acknowledge/Escalate",
  "- A set of links / runbooks      -> show_links (heading + links:[{label,url}])",
  "If the user explicitly asks for a card/table/incident/status/links, calling the",
  "tool IS the whole answer — never describe what the card 'would' contain in prose.",
  "Your text message alongside a rendered card MUST be empty or ONE short line (e.g.",
  `"Open ${LINEAR_TEAM_KEY} issues:"). NEVER restate the issues/rows/fields as text after rendering`,
  "— the card already shows them, and a duplicate text wall is the single most",
  "annoying thing you can do. Render, then stop.",
  "- ALWAYS populate each issue's state and priority as plain strings (e.g.",
  '  state:"In Progress", priority:"High") on the component props — the cards',
  "  use them for the status dot and the colored border. The Linear MCP returns",
  '  priority as an object {value, name}; pass its NAME string (e.g. "High"),',
  "  not the object. Map the issue's workflow status into state. Include",
  "  assignee, url, and updated too when you have them.",
  "",
  "WRITE GATING: a 'write' is CREATING or MODIFYING something in Linear or Notion",
  "(save_issue, create_page, …). ONLY before such a write, call the",
  "confirm_write tool with structured fields when creating an issue",
  "(title, description, assigneeEmail, team) plus a short action summary;",
  "wait for approval; perform the write only if confirmed, using the approved",
  "field values exactly. Rendering a card (issue_list, issue_card,",
  "show_incident, show_status, show_links) and any read (search/list/get,",
  "read_thread) are NOT writes — never gate them, and never add an",
  "'I'll need approval' disclaimer to a pure render or read.",
].join("\n");
}

/** Create the triage BuiltInAgent bound to the given env. */
export function createTriageAgent(env: TriageAgentEnv): BuiltInAgent {
  const model = (env.AGENT_MODEL ?? "openai/gpt-5.5").replace(
    /^openai\//,
    "",
  ) as Parameters<typeof openaiText>[0];
  const systemPrompt = buildSystemPrompt(env);

  return new BuiltInAgent({
    type: "tanstack",
    factory: async (ctx) => {
      const {
        messages,
        systemPrompts,
        tools: clientTools,
      } = convertInputToTanStackAI(ctx.input);

      const transports = mergeMcpTransports(
        mcpTransportsFromEnv(env),
        mcpTransportsFromContext(ctx.input, env),
      );
      const settled = await Promise.allSettled(
        transports.map((t) => connectMcp(t.transport)),
      );
      const clients: Array<Awaited<ReturnType<typeof connectMcp>>> = [];
      const unavailable: string[] = [];
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
          clients.push(result.value);
        } else {
          unavailable.push(transports[i]!.name);
          console.error(
            `[slack-runtime] MCP "${transports[i]!.name}" unavailable this turn:`,
            (result.reason as Error)?.message ?? result.reason,
          );
        }
      });

      const isAre = unavailable.length > 1 ? "are" : "is";
      const itsTheir = unavailable.length > 1 ? "their" : "its";
      const availabilityNote =
        unavailable.length > 0
          ? `\n\nDATA SOURCE STATUS: ${unavailable.join(" and ")} ${isAre} ` +
            `temporarily UNAVAILABLE this turn (connection failed), so ${itsTheir} ` +
            `tools are not loaded. Everything else — web search, rendering cards/` +
            `charts, reading the Slack thread — still works normally. ONLY if the ` +
            `user asks for something that needs ${unavailable.join(" or ")}, tell ` +
            `them that source is temporarily unreachable and to try again shortly; ` +
            `never invent data or claim a write/read succeeded.`
          : "";

      return chat({
        adapter: openaiText(model),
        messages,
        systemPrompts: [systemPrompt + availabilityNote, ...systemPrompts],
        tools: [
          webSearchTool({ type: "web_search" }),
          ...(clientTools as never[]),
        ],
        ...(clients.length > 0 ? { mcp: { clients } } : {}),
        middleware: [stripNullishToolArgsMiddleware],
        abortController: ctx.abortController,
      });
    },
  });
}
