import type { BlobRef } from "../types.js";

const BLOB_THRESHOLD_BYTES = 1_048_576; // 1MB

export interface BlobAdapter {
  put(key: string, data: Uint8Array | string, contentType: string): Promise<BlobRef>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export function shouldSpillToBlob(bytes: number): boolean {
  return bytes > BLOB_THRESHOLD_BYTES;
}

export function blobKeyForLog(logId: string): string {
  return `research-log/${logId}`;
}

/** Filesystem blob store for Railway MVP. */
export class FilesystemBlobAdapter implements BlobAdapter {
  constructor(private readonly basePath: string) {}

  async put(
    key: string,
    data: Uint8Array | string,
    contentType: string,
  ): Promise<BlobRef> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const fullPath = join(this.basePath, key);
    await mkdir(dirname(fullPath), { recursive: true });
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    await writeFile(fullPath, bytes);
    const logId = key.split("/").pop() ?? key;
    return { logId, key, bytes: bytes.length, contentType };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const buf = await readFile(join(this.basePath, key));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      await unlink(join(this.basePath, key));
    } catch {
      // ignore missing
    }
  }
}

/** In-memory blob store for tests. */
export class MemoryBlobAdapter implements BlobAdapter {
  private store = new Map<string, { data: Uint8Array; contentType: string }>();

  async put(
    key: string,
    data: Uint8Array | string,
    contentType: string,
  ): Promise<BlobRef> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.store.set(key, { data: bytes, contentType });
    const logId = key.split("/").pop() ?? key;
    return { logId, key, bytes: bytes.length, contentType };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.data ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
