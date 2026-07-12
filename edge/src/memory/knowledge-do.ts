/**
 * Longer-term knowledge store (PRODUCT.md Phase 3).
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { SqlExecutor } from "../store/sql.js";

export type KnowledgeRecord = {
  id: string;
  teamId: string;
  channelId: string | null;
  title: string;
  body: string;
  blobKey?: string;
  updatedAt: string;
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  blob_key TEXT,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge(team_id, channel_id)`,
];

function mapRow(row: {
  id: string;
  team_id: string;
  channel_id: string;
  title: string;
  body: string;
  blob_key: string | null;
  updated_at: string;
}): KnowledgeRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id || null,
    title: row.title,
    body: row.body,
    blobKey: row.blob_key ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class KnowledgeDO extends DurableObject {
  private migrated = false;

  private sql(): SqlExecutor {
    return this.ctx.storage.sql as unknown as SqlExecutor;
  }

  private migrate(): void {
    if (this.migrated) return;
    const sql = this.sql();
    for (const stmt of DDL) sql.exec(stmt);
    this.migrated = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.migrate();
    const url = new URL(request.url);
    const sql = this.sql();

    if (url.pathname === "/write" && request.method === "POST") {
      const rec = (await request.json()) as KnowledgeRecord;
      const id = rec.id || crypto.randomUUID();
      const updatedAt = rec.updatedAt || new Date().toISOString();
      sql.exec(
        `INSERT INTO knowledge (id, team_id, channel_id, title, body, blob_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           blob_key = excluded.blob_key,
           updated_at = excluded.updated_at`,
        id,
        rec.teamId,
        rec.channelId ?? "",
        rec.title,
        rec.body,
        rec.blobKey ?? null,
        updatedAt,
      );
      return Response.json({ ...rec, id, updatedAt });
    }

    if (url.pathname === "/search" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
        query: string;
        limit?: number;
      };
      const limit = body.limit ?? 10;
      const q = `%${body.query.toLowerCase()}%`;
      const rows = sql
        .exec<{
          id: string;
          team_id: string;
          channel_id: string;
          title: string;
          body: string;
          blob_key: string | null;
          updated_at: string;
        }>(
          `SELECT * FROM knowledge
           WHERE team_id = ?
             AND (channel_id = '' OR channel_id = ?)
             AND (lower(title) LIKE ? OR lower(body) LIKE ?)
           ORDER BY updated_at DESC
           LIMIT ?`,
          body.teamId,
          body.channelId ?? "",
          q,
          q,
          limit,
        )
        .toArray();
      return Response.json(rows.map(mapRow));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function memorySearch(
  ns: DurableObjectNamespace<KnowledgeDO>,
  teamId: string,
  channelId: string | undefined,
  query: string,
  limit = 10,
): Promise<KnowledgeRecord[]> {
  const stub = ns.get(ns.idFromName(teamId));
  return stub
    .fetch("https://do/search", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: channelId ?? null, query, limit }),
    })
    .then((r) => r.json()) as Promise<KnowledgeRecord[]>;
}

export async function memoryWrite(
  ns: DurableObjectNamespace<KnowledgeDO>,
  record: KnowledgeRecord,
): Promise<KnowledgeRecord> {
  const stub = ns.get(ns.idFromName(record.teamId));
  return stub
    .fetch("https://do/write", {
      method: "POST",
      body: JSON.stringify(record),
    })
    .then((r) => r.json()) as Promise<KnowledgeRecord>;
}
