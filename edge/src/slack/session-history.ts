import type { SlackFileRef } from "./download-files.js";

export type CanonicalHistoryMessage = {
  text: string;
  ts?: string;
  isBot: boolean;
  user?: { id?: string; name?: string; handle?: string };
  attachments: SlackFileRef[];
};

const DISPLAY_TEXT_LIMIT = 24_000;

function collectDisplayStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.join("\n").length >= DISPLAY_TEXT_LIMIT) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDisplayStrings(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "title", "pretext", "fallback", "alt_text"] as const) {
    if (typeof record[key] === "string" && record[key].trim()) out.push(record[key].trim());
    else collectDisplayStrings(record[key], out, depth + 1);
  }
  if (typeof record.url === "string" && !out.includes(record.url)) out.push(record.url);
  for (const key of ["blocks", "elements", "fields", "attachments"] as const) {
    collectDisplayStrings(record[key], out, depth + 1);
  }
}

/** Bounded Slack display text for plain, Block Kit, rich-text, and legacy messages. */
export function slackDisplayText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  const pieces: string[] = [];
  if (typeof record.text === "string" && record.text.trim()) pieces.push(record.text.trim());
  collectDisplayStrings(record.blocks, pieces);
  collectDisplayStrings(record.attachments, pieces);
  const files = Array.isArray(record.files) ? record.files : [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const item = file as SlackFileRef;
    const name = item.name ?? item.id ?? "file";
    pieces.push(`[Attachment: ${name}${item.mimetype ? ` (${item.mimetype})` : ""}]`);
  }
  const unique = pieces.filter((piece, index) => piece && pieces.indexOf(piece) === index);
  return unique.join("\n").slice(0, DISPLAY_TEXT_LIMIT);
}

export function slackHistoryAttachments(raw: unknown): SlackFileRef[] {
  const files = (raw as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((file): file is SlackFileRef => Boolean(file && typeof file === "object"))
    .map((file) => ({
      ...(file.id ? { id: file.id } : {}),
      ...(file.name ? { name: file.name } : {}),
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      ...(file.filetype ? { filetype: file.filetype } : {}),
      ...(file.url_private ? { url_private: file.url_private } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
    }));
}

export function normalizeSlackHistoryMessage(raw: unknown): CanonicalHistoryMessage {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const userId = typeof record.user === "string" ? record.user : undefined;
  return {
    text: slackDisplayText(record),
    ...(typeof record.ts === "string" ? { ts: record.ts } : {}),
    isBot: typeof record.bot_id === "string" || record.subtype === "bot_message",
    ...(userId ? { user: { id: userId } } : {}),
    attachments: slackHistoryAttachments(record),
  };
}

export type SessionReplayEvent = {
  id: number;
  executionId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
};

/** Rebuild complete user/assistant turns from the canonical append-only log. */
export function reconstructSessionHistory(
  events: SessionReplayEvent[],
  excludeExecutionId?: string,
): Array<{
  role: "user" | "bot";
  text: string;
  at?: number;
  attachments?: Array<{
    kind: "inline" | "staged";
    id: string;
    name: string;
    mimeType: string;
    size: number;
    stageKey?: string;
    sha256?: string;
    dataBase64?: string;
  }>;
}> {
  type Attachment = NonNullable<ReturnType<typeof reconstructSessionHistory>[number]["attachments"]>[number];
  const executions = new Map<string, {
    inputs: string[];
    outputs: string[];
    attachments: Attachment[];
    inputAt?: number;
    outputAt?: number;
  }>();
  for (const event of events) {
    if (event.executionId === excludeExecutionId) continue;
    const turn = executions.get(event.executionId) ?? {
      inputs: [],
      outputs: [],
      attachments: [],
    };
    if (event.kind === "input" && typeof event.payload === "string") {
      turn.inputAt ??= event.createdAt;
      let decoded = false;
      try {
        const payload = JSON.parse(event.payload) as {
          type?: unknown;
          text?: unknown;
          attachments?: unknown;
        };
        if (payload.type === "opentag_input_v1" && typeof payload.text === "string") {
          turn.inputs.push(payload.text);
          if (Array.isArray(payload.attachments)) {
            for (const item of payload.attachments) {
              if (!item || typeof item !== "object") continue;
              const attachment = item as Attachment;
              if (
                (attachment.kind === "inline" || attachment.kind === "staged") &&
                typeof attachment.id === "string" &&
                typeof attachment.name === "string" &&
                typeof attachment.mimeType === "string" &&
                typeof attachment.size === "number"
              ) {
                turn.attachments.push(
                  attachment.kind === "inline" && typeof attachment.dataBase64 === "string"
                    ? { ...attachment, kind: "inline" as const, dataBase64: attachment.dataBase64 }
                    : attachment.kind === "staged" && typeof attachment.stageKey === "string"
                      ? {
                          ...attachment,
                          kind: "staged" as const,
                          stageKey: attachment.stageKey,
                          ...(typeof attachment.sha256 === "string"
                            ? { sha256: attachment.sha256 }
                            : {}),
                        }
                      : attachment,
                );
              }
            }
          }
          decoded = true;
        }
      } catch { /* legacy plain-text input */ }
      if (!decoded) turn.inputs.push(event.payload);
    }
    if (event.kind === "output" && event.payload && typeof event.payload === "object") {
      turn.outputAt = event.createdAt;
      const payload = event.payload as { text?: unknown; tool?: unknown; summary?: unknown };
      if (typeof payload.text === "string") turn.outputs.push(payload.text);
      else if (typeof payload.tool === "string") {
        turn.outputs.push(`[Tool ${payload.tool}${typeof payload.summary === "string" ? `: ${payload.summary}` : ""}]`);
      }
    }
    executions.set(event.executionId, turn);
  }
  const history: Array<{ role: "user" | "bot"; text: string; at?: number }> = [];
  for (const turn of executions.values()) {
    const input = turn.inputs.join("\n").trim();
    const output = turn.outputs.join("").trim();
    if (input) history.push({
      role: "user",
      text: input,
      ...(turn.inputAt !== undefined ? { at: turn.inputAt } : {}),
      ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
    });
    if (output) history.push({
      role: "bot",
      text: output,
      ...(turn.outputAt !== undefined
        ? { at: turn.outputAt }
        : turn.inputAt !== undefined
          ? { at: turn.inputAt }
          : {}),
    });
  }
  return history;
}
