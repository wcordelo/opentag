/**
 * Durable per-conversation turn memory for Workers.
 *
 * AG-UI HttpAgent history is isolate-local, and Slack `conversations.replies`
 * can return empty (scope / race). Persist recent user (and optional bot) lines
 * in BOT_STATE so mid-thread turns keep title/description/email.
 *
 * Field labels are matched fuzzily (prefix / edit-distance to a small set of
 * canonical names) so typos like "descripton" still split correctly — without
 * enumerating every misspelling.
 */
import type { StateStore } from "../store/state-store-contract.js";

export type ThreadMemoryLine = {
  role: "user" | "bot";
  text: string;
  at: number;
  name?: string;
};

const MAX_LINES = 80;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function threadMemoryKey(conversationKey: string): string {
  return `threadmem:${conversationKey}`;
}

export async function appendThreadMemory(
  store: StateStore,
  conversationKey: string,
  line: ThreadMemoryLine,
): Promise<void> {
  if (!conversationKey || !line.text.trim()) return;
  await store.list.append(threadMemoryKey(conversationKey), line, {
    maxLen: MAX_LINES,
    ttlMs: TTL_MS,
  });
}

export async function readThreadMemory(
  store: StateStore,
  conversationKey: string,
): Promise<ThreadMemoryLine[]> {
  if (!conversationKey) return [];
  // listRange uses OFFSET; negative Redis-style indexes are not supported.
  return store.list.range<ThreadMemoryLine>(threadMemoryKey(conversationKey));
}

export type TicketDraft = {
  title?: string;
  description?: string;
  email?: string;
};

export type LastCreatedIssue = {
  identifier: string;
  url?: string;
  title?: string;
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ISSUE_ID_RE = /\b([A-Z]{2,10}-\d+)\b/;
const LINEAR_URL_RE =
  /https?:\/\/linear\.app\/[^\s>|]+/i;

const CANONICAL_LABELS = [
  "title",
  "description",
  "email",
  "assignee",
  "priority",
  "team",
] as const;

type CanonicalLabel = (typeof CANONICAL_LABELS)[number];

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur =
        a[i] === b[j]
          ? row[j]!
          : 1 + Math.min(row[j]!, row[j + 1]!, prev);
      row[j] = prev;
      prev = cur;
    }
    row[b.length] = prev;
  }
  return row[b.length]!;
}

/**
 * Map a free-typed field label to a canonical name.
 * Uses prefixes + edit-distance — not a typo allowlist.
 */
export function canonicalizeFieldLabel(raw: string): CanonicalLabel | undefined {
  const w = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!w || w.length < 3) return undefined;

  // Description: any word that clearly means description (prefix or close).
  if (w === "desc" || w.startsWith("desc") || w.startsWith("descript")) {
    return "description";
  }
  if (w.startsWith("assign")) return "assignee";

  for (const c of CANONICAL_LABELS) {
    if (w === c) return c;
    const maxDist = c.length <= 5 ? 1 : 2;
    if (levenshtein(w, c) <= maxDist) return c;
  }
  return undefined;
}

/**
 * Split labeled ticket fields from one message (colons optional, labels fuzzy).
 * Example: `title: test descripton test test` → title=test, description=test test
 */
export function parseLabeledFields(text: string): TicketDraft {
  const draft: TicketDraft = {};
  const s = text.replace(/\r\n/g, "\n").trim();
  if (!s) return draft;

  type Hit = { label: CanonicalLabel; labelStart: number; valueStart: number };
  const hits: Hit[] = [];
  const re = /\b([A-Za-z]{3,24})\s*[:\-]?\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const word = m[1]!;
    const canon = canonicalizeFieldLabel(word);
    if (!canon) continue;
    const atBoundary = m.index === 0 || /[\s\n]/.test(s[m.index - 1] ?? " ");
    if (!atBoundary) continue;
    const afterWord = s.slice(m.index + word.length);
    const hasSep = /^\s*[:\-]/.test(afterWord);
    const highConfidence =
      canon === "title" ||
      canon === "description" ||
      canon === "email" ||
      hasSep;
    if (!highConfidence) continue;
    hits.push({
      label: canon,
      labelStart: m.index,
      valueStart: m.index + m[0].length,
    });
  }

  // First occurrence of each label, left-to-right.
  const ordered: Hit[] = [];
  const seen = new Set<CanonicalLabel>();
  for (const h of hits) {
    if (seen.has(h.label)) continue;
    seen.add(h.label);
    ordered.push(h);
  }
  ordered.sort((a, b) => a.labelStart - b.labelStart);

  for (let i = 0; i < ordered.length; i++) {
    const hit = ordered[i]!;
    const valueEnd =
      i + 1 < ordered.length ? ordered[i + 1]!.labelStart : s.length;
    const value = s.slice(hit.valueStart, valueEnd).replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (hit.label === "title") draft.title = value;
    else if (hit.label === "description") draft.description = value;
    else if (hit.label === "email" || hit.label === "assignee") {
      const email = value.match(EMAIL_RE)?.[0];
      if (email) draft.email = email.toLowerCase();
    }
  }

  if (!draft.email) {
    const email = s.match(EMAIL_RE)?.[0];
    if (email) draft.email = email.toLowerCase();
  }

  return draft;
}

/**
 * Repair mashed title/description from the model (e.g. title contains a
 * misspelled "description" label). Safe no-op when fields are already clean.
 */
export function coerceTicketFields(input: {
  title?: string;
  description?: string;
}): { title?: string; description?: string } {
  const title = input.title?.trim();
  const description = input.description?.trim();
  if (!title) return { title, description };

  const looksMashed =
    !description &&
    /\bdesc[a-z]{0,20}\b/i.test(title) &&
    !/^\s*desc[a-z]{0,20}\s*$/i.test(title);

  if (!looksMashed && description) return { title, description };
  if (!looksMashed && !/\b(title|desc[a-z]*)\b/i.test(title)) {
    return { title, description };
  }

  const blob = /^\s*title\b/i.test(title)
    ? title
    : `title: ${title}${description ? ` description: ${description}` : ""}`;
  const parsed = parseLabeledFields(blob);
  return {
    title: parsed.title ?? title,
    description: parsed.description ?? description,
  };
}

/**
 * Best-effort parse of ticket fields from free-form Slack lines.
 * Newest matching lines win for each field.
 */
export function parseTicketDraft(
  lines: Array<{ text?: string; isBot?: boolean; role?: string }>,
): TicketDraft {
  const draft: TicketDraft = {};
  for (const line of lines) {
    if (line.isBot || line.role === "bot") continue;
    const text = (line.text ?? "").trim();
    if (!text) continue;

    const parsed = parseLabeledFields(text);
    if (parsed.title) draft.title = parsed.title;
    if (parsed.description) draft.description = parsed.description;
    if (parsed.email) draft.email = parsed.email;

    if (!parsed.email) {
      const emailMatch = text.match(EMAIL_RE);
      if (emailMatch && !/^\s*title\b/i.test(text)) {
        draft.email = emailMatch[0]!.toLowerCase();
      }
    }
  }
  return draft;
}

/** Recent user lines that look like they may contain ticket fields. */
export function candidateFieldLines(
  lines: Array<{ text?: string; isBot?: boolean; role?: string }>,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.isBot || line.role === "bot") continue;
    const text = (line.text ?? "").trim();
    if (!text) continue;
    if (
      EMAIL_RE.test(text) ||
      /\b(title|desc|description|email|assign|priority|team)\b/i.test(text) ||
      /:/.test(text)
    ) {
      out.push(text);
    }
  }
  return out.slice(-8);
}

/** Find the most recently created Linear issue mentioned in the thread. */
export function parseLastCreatedIssue(
  lines: Array<{ text?: string; isBot?: boolean; role?: string }>,
): LastCreatedIssue | undefined {
  let last: LastCreatedIssue | undefined;
  for (const line of lines) {
    const text = (line.text ?? "").trim();
    if (!text) continue;
    const created = text.match(
      /Created Linear issue\s+([A-Z]{2,10}-\d+)\s*:?\s*(.*)$/i,
    );
    if (created) {
      last = {
        identifier: created[1]!,
        title: created[2]?.trim() || undefined,
      };
      const url = text.match(LINEAR_URL_RE)?.[0];
      if (url) last.url = url;
      continue;
    }
    const id = text.match(ISSUE_ID_RE)?.[1];
    const url = text.match(LINEAR_URL_RE)?.[0];
    if (id && (line.isBot || line.role === "bot" || url)) {
      last = { identifier: id, url, title: last?.title };
    }
  }
  return last;
}

export function formatDraftContext(
  draft: TicketDraft,
  candidates: string[] = [],
): string {
  const lines = [
    "Ticket fields from this Slack thread — interpret them YOURSELF.",
    "Humans type fast: misspelled labels, missing colons, fields on one line,",
    "wrong order, or shorthand. Infer title / description / assignee email from",
    "intent. Do NOT require perfect spelling of field names.",
    "Only ask a clarifying question when a field is genuinely missing after",
    "reading the whole thread — never because of a typo.",
    "When ready, call confirm_write with structured title, description,",
    "assigneeEmail, and team — never mash description into title.",
    "If Linear assignee email is in context, pass it as assigneeEmail and do not ask for email.",
  ];
  if (candidates.length > 0) {
    lines.push("Recent user lines that may contain fields:");
    for (const c of candidates) {
      lines.push(`  • ${c}`);
    }
  }
  if (draft.title || draft.description || draft.email) {
    lines.push(
      "Parsed fields (prefer these when they look right):",
      `  title = ${JSON.stringify(draft.title ?? "")}`,
      `  description = ${JSON.stringify(draft.description ?? "")}`,
      `  assignee email = ${JSON.stringify(draft.email ?? "")}`,
    );
  }
  return lines.join("\n");
}

export function formatLastIssueContext(issue: LastCreatedIssue): string {
  const url =
    issue.url ??
    `https://linear.app/berendo/issue/${issue.identifier}`;
  return [
    `Last Linear issue created in this thread: ${issue.identifier}`,
    issue.title ? `title: ${issue.title}` : undefined,
    `url: ${url}`,
    "If the user asks for the link / URL / ticket, reply with this URL only.",
    "Do NOT call confirm_write or save_issue again unless they ask to create another.",
  ]
    .filter(Boolean)
    .join("\n");
}
