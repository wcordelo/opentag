/**
 * Normalize authenticated image attachments after digest verification and
 * before the Claude prompt references local paths.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const IMAGE_LONG_EDGE_MAX = 1568;
export const IMAGE_ENCODED_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MIN_JPEG_QUALITY = 40;

export type NormalizedAttachmentMeta = {
  attachmentId: string;
  originalMime: string;
  originalSize: number;
  originalDigest: string;
  derivedMime: string;
  derivedSize: number;
  width: number;
  height: number;
  normalized: boolean;
  path: string;
};

export type NormalizeImageResult =
  | { ok: true; meta: NormalizedAttachmentMeta }
  | { ok: false; error: string };

const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function isImageMime(mimeType: string): boolean {
  return IMAGE_MIME.has(mimeType.toLowerCase());
}

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type SharpLike = {
  (input: Buffer, opts?: { animated?: boolean; pages?: number }): {
    metadata(): Promise<{
      width?: number;
      height?: number;
      format?: string;
      hasAlpha?: boolean;
      orientation?: number;
    }>;
    rotate(): { resize: SharpResize };
    resize: SharpResize;
  };
};

type SharpResize = (
  width: number,
  height: number,
  opts: { fit: string; withoutEnlargement: boolean },
) => {
  jpeg(opts: { quality: number; mozjpeg?: boolean }): { toBuffer(): Promise<Buffer> };
  png(): { toBuffer(): Promise<Buffer> };
  webp(opts: { quality?: number; lossless?: boolean }): { toBuffer(): Promise<Buffer> };
};

async function loadSharp(): Promise<SharpLike> {
  const mod = await import("sharp");
  return (mod.default ?? mod) as SharpLike;
}

function derivedSuffix(mime: string): string {
  if (mime === "image/png") return ".normalized.png";
  if (mime === "image/webp") return ".normalized.webp";
  return ".normalized.jpg";
}

/**
 * If the original already fits provider bounds, return it unchanged.
 * Otherwise auto-orient, resize inside 1568², strip metadata, and re-encode.
 */
export async function normalizeImageFile(opts: {
  attachmentId: string;
  sourcePath: string;
  mimeType: string;
  expectedSize: number;
  expectedDigest?: string;
  executionHome: string;
}): Promise<NormalizeImageResult> {
  if (!isImageMime(opts.mimeType)) {
    return {
      ok: true,
      meta: {
        attachmentId: opts.attachmentId,
        originalMime: opts.mimeType,
        originalSize: opts.expectedSize,
        originalDigest: opts.expectedDigest ?? "",
        derivedMime: opts.mimeType,
        derivedSize: opts.expectedSize,
        width: 0,
        height: 0,
        normalized: false,
        path: opts.sourcePath,
      },
    };
  }

  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(opts.sourcePath);
  } catch {
    return { ok: false, error: `image_read_failed:${opts.attachmentId}` };
  }
  if (bytes.byteLength !== opts.expectedSize) {
    return { ok: false, error: `attachment_size_mismatch:${opts.attachmentId}` };
  }
  const digest = sha256Hex(bytes);
  if (opts.expectedDigest && digest !== opts.expectedDigest) {
    return { ok: false, error: `attachment_digest_mismatch:${opts.attachmentId}` };
  }

  let sharp: SharpLike;
  try {
    sharp = await loadSharp();
  } catch {
    return { ok: false, error: "image_normalization_unavailable" };
  }

  let metadata: {
    width?: number;
    height?: number;
    format?: string;
    hasAlpha?: boolean;
  };
  try {
    metadata = await sharp(bytes, { animated: false, pages: 1 }).metadata();
  } catch {
    return { ok: false, error: `image_undecodable:${opts.attachmentId}` };
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0 || width * height > 50_000_000) {
    return { ok: false, error: `image_normalization_limit:${opts.attachmentId}` };
  }

  const longEdge = Math.max(width, height);
  const alreadySafe =
    longEdge <= IMAGE_LONG_EDGE_MAX && bytes.byteLength <= IMAGE_ENCODED_MAX_BYTES;
  if (alreadySafe) {
    return {
      ok: true,
      meta: {
        attachmentId: opts.attachmentId,
        originalMime: opts.mimeType,
        originalSize: bytes.byteLength,
        originalDigest: digest,
        derivedMime: opts.mimeType,
        derivedSize: bytes.byteLength,
        width,
        height,
        normalized: false,
        path: opts.sourcePath,
      },
    };
  }

  const hasAlpha = metadata.hasAlpha === true;
  let quality = 80;
  let derived: Buffer | undefined;
  let derivedMime = hasAlpha ? "image/webp" : "image/jpeg";

  while (quality >= IMAGE_MIN_JPEG_QUALITY) {
    try {
      const pipeline = sharp(bytes, { animated: false, pages: 1 })
        .rotate()
        .resize(IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MAX, {
          fit: "inside",
          withoutEnlargement: true,
        });
      if (hasAlpha) {
        derived = await pipeline.webp({ lossless: quality >= 75 }).toBuffer();
        derivedMime = "image/webp";
      } else {
        derived = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
        derivedMime = "image/jpeg";
      }
    } catch {
      return { ok: false, error: `image_transform_failed:${opts.attachmentId}` };
    }
    if (derived.byteLength <= IMAGE_ENCODED_MAX_BYTES) break;
    quality -= 10;
  }

  if (!derived || derived.byteLength > IMAGE_ENCODED_MAX_BYTES) {
    // Last chance: if original independently satisfies bounds, keep it.
    if (alreadySafe) {
      return {
        ok: true,
        meta: {
          attachmentId: opts.attachmentId,
          originalMime: opts.mimeType,
          originalSize: bytes.byteLength,
          originalDigest: digest,
          derivedMime: opts.mimeType,
          derivedSize: bytes.byteLength,
          width,
          height,
          normalized: false,
          path: opts.sourcePath,
        },
      };
    }
    return { ok: false, error: `image_normalization_limit:${opts.attachmentId}` };
  }

  const derivedPath = `${opts.sourcePath}${derivedSuffix(derivedMime)}`;
  const resolved = path.resolve(derivedPath);
  if (!resolved.startsWith(path.resolve(opts.executionHome) + path.sep)) {
    return { ok: false, error: `image_path_escape:${opts.attachmentId}` };
  }

  const handle = await fs.promises.open(derivedPath, "wx", 0o600);
  try {
    await handle.writeFile(derived);
  } finally {
    await handle.close();
  }

  let derivedMeta: { width?: number; height?: number };
  try {
    derivedMeta = await sharp(derived).metadata();
  } catch {
    derivedMeta = { width, height };
  }

  return {
    ok: true,
    meta: {
      attachmentId: opts.attachmentId,
      originalMime: opts.mimeType,
      originalSize: bytes.byteLength,
      originalDigest: digest,
      derivedMime,
      derivedSize: derived.byteLength,
      width: derivedMeta.width ?? width,
      height: derivedMeta.height ?? height,
      normalized: true,
      path: derivedPath,
    },
  };
}
