/**
 * Workers-safe Slack file → AG-UI content parts (no Node Buffer).
 * Mirrors @copilotkit/channels-slack buildFileContentParts semantics.
 */
export type SlackFileRef = {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  size?: number;
};

type MediaDataSource = { type: "data"; value: string; mimeType: string };

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: MediaDataSource }
  | { type: "audio"; source: MediaDataSource }
  | { type: "video"; source: MediaDataSource }
  | { type: "document"; source: MediaDataSource };

export type FileDeliveryConfig = {
  maxBytesPerFile?: number;
  maxFiles?: number;
  maxTextBytes?: number;
};

const DEFAULTS = {
  maxBytesPerFile: 8 * 1024 * 1024,
  maxFiles: 5,
  maxTextBytes: 200 * 1024,
} as const;

const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/csv",
  "application/xml",
  "application/x-ndjson",
  "application/yaml",
]);

function isText(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_MIME_EXACT.has(mime);
}

function mediaPartType(
  mime: string,
): "image" | "audio" | "video" | "document" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "document";
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function extractSlackFiles(event: unknown): SlackFileRef[] {
  const files = (event as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (f): f is SlackFileRef =>
      !!f && typeof f === "object" && typeof (f as SlackFileRef).url_private === "string",
  );
}

export async function buildFileContentParts(
  files: SlackFileRef[],
  botToken: string,
  config: FileDeliveryConfig = {},
): Promise<{ parts: AgentContentPart[]; notes: string[] }> {
  const maxBytes = config.maxBytesPerFile ?? DEFAULTS.maxBytesPerFile;
  const maxFiles = config.maxFiles ?? DEFAULTS.maxFiles;
  const maxText = config.maxTextBytes ?? DEFAULTS.maxTextBytes;

  const parts: AgentContentPart[] = [];
  const notes: string[] = [];
  const considered = files.slice(0, maxFiles);
  if (files.length > maxFiles) {
    notes.push(
      `(only the first ${maxFiles} of ${files.length} files processed)`,
    );
  }

  for (const f of considered) {
    const label = f.name ?? f.id ?? "file";
    const mime = (f.mimetype ?? "").toLowerCase();
    const media = mediaPartType(mime);
    if (!f.url_private) {
      notes.push(`skipped "${label}": no download URL`);
      continue;
    }
    if (!media && !isText(mime)) {
      notes.push(
        `skipped "${label}" (${mime || f.filetype || "unknown"}): unsupported type`,
      );
      continue;
    }
    if (typeof f.size === "number" && f.size > maxBytes) {
      notes.push(
        `skipped "${label}": ${f.size} bytes exceeds the ${maxBytes}-byte cap`,
      );
      continue;
    }

    let bytes: Uint8Array;
    try {
      const res = await fetch(f.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) {
        notes.push(`skipped "${label}": download failed (HTTP ${res.status})`);
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      notes.push(`skipped "${label}": ${(err as Error).message}`);
      continue;
    }
    if (bytes.byteLength > maxBytes) {
      notes.push(
        `skipped "${label}": ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte cap`,
      );
      continue;
    }

    if (media) {
      parts.push({
        type: media,
        source: {
          type: "data",
          value: toBase64(bytes),
          mimeType: mime,
        },
      });
    } else {
      let buf = bytes;
      let truncated = false;
      if (buf.byteLength > maxText) {
        buf = buf.subarray(0, maxText);
        truncated = true;
      }
      parts.push({
        type: "text",
        text:
          `Attached file "${label}" (${mime}${truncated ? ", truncated" : ""}):\n` +
          utf8Decode(buf),
      });
    }
  }

  return { parts, notes };
}

/** Combine user text + downloaded file parts for runAgent prompt. */
export function mergePromptParts(
  userText: string,
  fileParts: AgentContentPart[],
  notes: string[],
): string | AgentContentPart[] {
  if (fileParts.length === 0 && notes.length === 0) return userText;
  const content: AgentContentPart[] = [];
  if (userText.trim()) content.push({ type: "text", text: userText });
  content.push(...fileParts);
  if (notes.length > 0) {
    content.push({
      type: "text",
      text: `[attachment notes: ${notes.join("; ")}]`,
    });
  }
  return content.length > 0 ? content : userText;
}
