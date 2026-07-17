const MAX_DEPTH = 12;
const MAX_NODES = 2_000;
const MAX_ARRAY = 200;
const MAX_STRING = 3_000;
export const MAX_RICH_DISPLAY_TEXT = 24_000;

export type RichDisplayResult = Readonly<{
  hasMention: boolean;
  displayText: string;
}>;

type RichFieldContext =
  | "block"
  | "attachment"
  | "attachment_field";

function exactMentionPattern(userId: string): RegExp {
  return new RegExp(
    `<@${userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\|[^>]{0,256})?>`,
    "g",
  );
}

export function extractRichDisplayText(
  event: unknown,
  targetUserId: string,
): RichDisplayResult {
  if (!event || typeof event !== "object" || !targetUserId) {
    return Object.freeze({ hasMention: false, displayText: "" });
  }
  const root = event as Record<string, unknown>;
  const roots = [root.blocks, root.attachments];
  const visited = new WeakSet<object>();
  const pieces: string[] = [];
  let nodes = 0;
  let hasMention = false;
  let total = 0;
  const mention = exactMentionPattern(targetUserId);

  const add = (raw: string) => {
    if (total >= MAX_RICH_DISPLAY_TEXT) return;
    const value = raw.normalize("NFKC").slice(0, MAX_STRING);
    mention.lastIndex = 0;
    if (mention.test(value)) hasMention = true;
    mention.lastIndex = 0;
    const cleaned = value.replace(mention, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const remaining = MAX_RICH_DISPLAY_TEXT - total;
    const bounded = cleaned.slice(0, remaining);
    if (!bounded) return;
    pieces.push(bounded);
    total += bounded.length + 1;
  };

  const visit = (
    value: unknown,
    depth: number,
    context: RichFieldContext,
  ) => {
    if (
      value === null ||
      value === undefined ||
      depth > MAX_DEPTH ||
      nodes >= MAX_NODES ||
      total >= MAX_RICH_DISPLAY_TEXT
    ) return;
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    nodes += 1;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, MAX_ARRAY)) {
        visit(child, depth + 1, context);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === "user" &&
      typeof record.user_id === "string" &&
      record.user_id === targetUserId
    ) {
      hasMention = true;
    }
    for (const key of ["text", "pretext", "fallback", "title"] as const) {
      if (key in record) visit(record[key], depth + 1, context);
    }
    // Legacy attachment field values are visible alert text. Block Kit action
    // values are hidden callback metadata and must never satisfy a mention.
    if (context === "attachment_field" && "value" in record) {
      visit(record.value, depth + 1, context);
    }
    if ("fields" in record) {
      visit(record.fields, depth + 1, "attachment_field");
    }
    if ("elements" in record) {
      visit(record.elements, depth + 1, context);
    }
    if ("blocks" in record) {
      visit(record.blocks, depth + 1, "block");
    }
    if ("attachments" in record) {
      visit(record.attachments, depth + 1, "attachment");
    }
  };
  visit(roots[0], 0, "block");
  visit(roots[1], 0, "attachment");
  return Object.freeze({
    hasMention,
    displayText: pieces.join("\n").slice(0, MAX_RICH_DISPLAY_TEXT).trim(),
  });
}
