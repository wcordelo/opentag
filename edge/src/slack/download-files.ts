/**
 * Workers-safe Slack file → AG-UI content parts (no Node Buffer).
 * Mirrors @copilotkit/channels-slack buildFileContentParts semantics.
 */
import type { R2Bucket } from "@cloudflare/workers-types";
export type SlackFileRef = {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  size?: number;
};

type MediaDataSource = { type: "data"; value: string; mimeType: string };

export type PreparedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
} & (
  | { kind: "inline"; dataBase64: string }
  | { kind: "staged"; stageKey: string; sha256?: string }
);

export type AgentContentPart =
  | { type: "text"; text: string; attachment?: PreparedAttachment }
  | { type: "image"; source: MediaDataSource; attachment?: PreparedAttachment }
  | { type: "audio"; source: MediaDataSource; attachment?: PreparedAttachment }
  | { type: "video"; source: MediaDataSource; attachment?: PreparedAttachment }
  | { type: "document"; source: MediaDataSource; attachment?: PreparedAttachment };

export type AttachmentStager = (input: {
  file: SlackFileRef;
  bytes: Uint8Array;
  mimeType: string;
}) => Promise<{ stageKey: string; sha256?: string }>;

/** Content-addressed durable staging shared by live and reconstructed files. */
export function createR2AttachmentStager(bucket: R2Bucket): AttachmentStager {
  return async ({ file, bytes, mimeType }) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const safeName = (file.name ?? file.id ?? "attachment").replace(/[^A-Za-z0-9._-]+/g, "_");
    const stageKey = `slack-attachments/${sha256}/${safeName}`;
    await bucket.put(stageKey, bytes, {
      httpMetadata: { contentType: mimeType || "application/octet-stream" },
      customMetadata: { slackFileId: file.id ?? "", sha256 },
    });
    return { stageKey, sha256 };
  };
}

export type FileDeliveryConfig = {
  maxBytesPerFile?: number;
  maxFiles?: number;
  maxTextBytes?: number;
  /** Upper bound for an inline AG-UI/harness attachment. */
  maxInlineBytes?: number;
  /** Upper bound accepted when a durable stager is supplied. */
  maxStagedBytes?: number;
  stage?: AttachmentStager;
};

const DEFAULTS = {
  maxBytesPerFile: 8 * 1024 * 1024,
  maxFiles: 5,
  maxTextBytes: 200 * 1024,
  maxStagedBytes: 32 * 1024 * 1024,
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

function withAttachment<T extends Omit<AgentContentPart, "attachment">>(
  part: T,
  attachment: PreparedAttachment,
): T & { attachment: PreparedAttachment } {
  // Agent-turn can read this metadata in-process, while AG-UI JSON encoding
  // sees only its native content shape (and does not duplicate base64 bytes).
  Object.defineProperty(part, "attachment", { value: attachment, enumerable: false });
  return part as T & { attachment: PreparedAttachment };
}

async function readResponseBounded(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("attachment_too_large");
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error("attachment_too_large");
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("attachment_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  const maxInlineBytes = config.maxInlineBytes ?? maxBytes;
  const maxStagedBytes = config.maxStagedBytes ?? DEFAULTS.maxStagedBytes;
  const downloadLimit = config.stage ? maxStagedBytes : maxInlineBytes;
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
    if (typeof f.size === "number" && f.size > downloadLimit) {
      notes.push(
        `skipped "${label}": ${f.size} bytes exceeds the ${downloadLimit}-byte cap`,
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
      bytes = await readResponseBounded(res, downloadLimit);
    } catch (err) {
      notes.push(`skipped "${label}": ${(err as Error).message}`);
      continue;
    }
    const id = f.id ?? `${label}:${bytes.byteLength}`;
    let prepared: PreparedAttachment;
    if (bytes.byteLength <= maxInlineBytes) {
      prepared = {
        kind: "inline",
        id,
        name: label,
        mimeType: mime || "application/octet-stream",
        size: bytes.byteLength,
        dataBase64: toBase64(bytes),
      };
    } else if (config.stage) {
      try {
        const staged = await config.stage({ file: f, bytes, mimeType: mime });
        prepared = {
          kind: "staged",
          id,
          name: label,
          mimeType: mime || "application/octet-stream",
          size: bytes.byteLength,
          stageKey: staged.stageKey,
          ...(staged.sha256 ? { sha256: staged.sha256 } : {}),
        };
      } catch (err) {
        notes.push(`skipped "${label}": staging failed (${(err as Error).message})`);
        continue;
      }
    } else {
      notes.push(`skipped "${label}": durable staging is not configured`);
      continue;
    }

    if (media && prepared.kind === "inline") {
      parts.push(withAttachment({
        type: media,
        source: {
          type: "data",
          value: toBase64(bytes),
          mimeType: mime,
        },
      }, prepared));
    } else if (prepared.kind === "inline") {
      let buf = bytes;
      let truncated = false;
      if (buf.byteLength > maxText) {
        buf = buf.subarray(0, maxText);
        truncated = true;
      }
      parts.push(withAttachment({
        type: "text",
        text:
          `Attached file "${label}" (${mime}${truncated ? ", truncated" : ""}):\n` +
          utf8Decode(buf),
      }, prepared));
    } else {
      parts.push(withAttachment({
        type: "text",
        text: `[Staged attachment: ${label} (${mime}, ${bytes.byteLength} bytes)]`,
      }, prepared));
    }
  }

  return { parts, notes };
}

/** Rehydrate canonical session attachment refs (staged R2 keys or inline bytes). */
export async function buildPreparedAttachmentContentParts(
  attachments: PreparedAttachment[],
  bucket: R2Bucket,
  config: Pick<FileDeliveryConfig, "maxFiles" | "maxTextBytes" | "maxInlineBytes"> = {},
): Promise<{ parts: AgentContentPart[]; notes: string[] }> {
  const maxFiles = config.maxFiles ?? DEFAULTS.maxFiles;
  const maxText = config.maxTextBytes ?? DEFAULTS.maxTextBytes;
  const maxInlineBytes = config.maxInlineBytes ?? DEFAULTS.maxBytesPerFile;

  const parts: AgentContentPart[] = [];
  const notes: string[] = [];
  const considered = attachments.slice(0, maxFiles);
  if (attachments.length > maxFiles) {
    notes.push(
      `(only the first ${maxFiles} of ${attachments.length} files processed)`,
    );
  }

  for (const attachment of considered) {
    const label = attachment.name ?? attachment.id ?? "file";
    const mime = (attachment.mimeType ?? "").toLowerCase();
    const media = mediaPartType(mime);

    let bytes: Uint8Array;
    let prepared: PreparedAttachment;

    if (attachment.kind === "inline") {
      if (!attachment.dataBase64) {
        notes.push(`skipped "${label}": inline attachment has no stored bytes`);
        continue;
      }
      try {
        const binary = atob(attachment.dataBase64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      } catch (err) {
        notes.push(`skipped "${label}": ${(err as Error).message}`);
        continue;
      }
      prepared = attachment;
    } else {
      const object = await bucket.get(attachment.stageKey);
      if (!object) {
        notes.push(`skipped "${label}": staged attachment not found in storage`);
        continue;
      }
      bytes = new Uint8Array(await object.arrayBuffer());
      if (typeof attachment.size === "number" && bytes.byteLength !== attachment.size) {
        notes.push(`skipped "${label}": staged attachment size mismatch`);
        continue;
      }
      if (attachment.sha256) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (sha256 !== attachment.sha256) {
          notes.push(`skipped "${label}": staged attachment digest mismatch`);
          continue;
        }
      }
      prepared = attachment;
    }

    if (!media && !isText(mime)) {
      notes.push(
        `skipped "${label}" (${mime || "unknown"}): unsupported type`,
      );
      continue;
    }

    if (media && prepared.kind === "inline") {
      parts.push(withAttachment({
        type: media,
        source: {
          type: "data",
          value: toBase64(bytes),
          mimeType: mime,
        },
      }, prepared));
    } else if (prepared.kind === "inline") {
      let buf = bytes;
      let truncated = false;
      if (buf.byteLength > maxText) {
        buf = buf.subarray(0, maxText);
        truncated = true;
      }
      parts.push(withAttachment({
        type: "text",
        text:
          `Attached file "${label}" (${mime}${truncated ? ", truncated" : ""}):\n` +
          utf8Decode(buf),
      }, prepared));
    } else {
      parts.push(withAttachment({
        type: "text",
        text: `[Staged attachment: ${label} (${mime}, ${bytes.byteLength} bytes)]`,
      }, prepared));
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
