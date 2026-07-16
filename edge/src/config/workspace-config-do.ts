/**
 * Workspace / channel config Durable Object (PRODUCT.md Phase 2).
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { SqlExecutor } from "../store/sql.js";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "./access-bundle.js";

export {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  resolveAllowedTools,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "./access-bundle.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS channel_config (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  policies_json TEXT NOT NULL DEFAULT '{}',
  access_bundle_id TEXT NOT NULL DEFAULT 'default',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id)
)`,
  `CREATE TABLE IF NOT EXISTS access_bundles (
  id TEXT PRIMARY KEY,
  tools_json TEXT NOT NULL,
  mcp_json TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL
)`,
];

export class WorkspaceConfigDO extends DurableObject {
  private migrated = false;

  private sql(): SqlExecutor {
    return this.ctx.storage.sql as unknown as SqlExecutor;
  }

  private migrate(): void {
    if (this.migrated) return;
    const sql = this.sql();
    for (const stmt of DDL) sql.exec(stmt);
    const columns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(channel_config)")
        .toArray()
        .map((row) => row.name),
    );
    if (!columns.has("default_harness_type")) {
      sql.exec("ALTER TABLE channel_config ADD COLUMN default_harness_type TEXT");
    }
    if (!columns.has("default_model")) {
      sql.exec("ALTER TABLE channel_config ADD COLUMN default_model TEXT");
    }
    const existing = sql
      .exec<{ id: string }>(
        "SELECT id FROM access_bundles WHERE id = ?",
        DEFAULT_BUNDLE.id,
      )
      .toArray();
    if (existing.length === 0) {
      sql.exec(
        `INSERT INTO access_bundles (id, tools_json, mcp_json, secret_refs_json) VALUES (?, ?, ?, ?)`,
        DEFAULT_BUNDLE.id,
        JSON.stringify(DEFAULT_BUNDLE.tools),
        JSON.stringify(DEFAULT_BUNDLE.mcpEndpoints),
        JSON.stringify(DEFAULT_BUNDLE.secretRefs),
      );
    }
    this.migrated = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.migrate();
    const url = new URL(request.url);
    const sql = this.sql();

    if (url.pathname === "/getConfig" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
      };
      const channelKey = body.channelId ?? "";
      let rows = sql
        .exec<{
          team_id: string;
          channel_id: string;
          system_prompt: string;
          policies_json: string;
          access_bundle_id: string;
          default_harness_type: string | null;
          default_model: string | null;
          updated_at: string;
        }>(
          `SELECT * FROM channel_config WHERE team_id = ? AND channel_id = ?`,
          body.teamId,
          channelKey,
        )
        .toArray();
      if (rows.length === 0 && channelKey !== "") {
        rows = sql
          .exec<{
            team_id: string;
            channel_id: string;
            system_prompt: string;
            policies_json: string;
              access_bundle_id: string;
              default_harness_type: string | null;
              default_model: string | null;
              updated_at: string;
          }>(
            `SELECT * FROM channel_config WHERE team_id = ? AND channel_id = ''`,
            body.teamId,
          )
          .toArray();
      }
      const row = rows[0];
      const config: WorkspaceChannelConfig = row
        ? {
            teamId: row.team_id,
            channelId: row.channel_id || null,
            systemPrompt: row.system_prompt,
            policies: JSON.parse(row.policies_json) as WorkspaceChannelConfig["policies"],
            accessBundleId: row.access_bundle_id,
            runtimeDefaults: normalizeChannelRuntimeDefaults({
              harnessType: row.default_harness_type ?? undefined,
              model: row.default_model ?? undefined,
            }),
            updatedAt: row.updated_at,
          }
        : {
            teamId: body.teamId,
            channelId: body.channelId ?? null,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            policies: { allowMemoryWrite: true, allowTasks: true },
            accessBundleId: DEFAULT_BUNDLE.id,
            updatedAt: new Date().toISOString(),
          };
      return Response.json(config);
    }

    if (url.pathname === "/putConfig" && request.method === "POST") {
      const cfg = (await request.json()) as WorkspaceChannelConfig;
      let runtimeDefaults;
      try {
        runtimeDefaults = normalizeChannelRuntimeDefaults(cfg.runtimeDefaults);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid runtime defaults" },
          { status: 400 },
        );
      }
      const channelKey = cfg.channelId ?? "";
      sql.exec(
        `INSERT INTO channel_config (
           team_id, channel_id, system_prompt, policies_json, access_bundle_id,
           default_harness_type, default_model, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, channel_id) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           policies_json = excluded.policies_json,
           access_bundle_id = excluded.access_bundle_id,
           default_harness_type = excluded.default_harness_type,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at`,
        cfg.teamId,
        channelKey,
        cfg.systemPrompt,
        JSON.stringify(cfg.policies ?? {}),
        cfg.accessBundleId,
        runtimeDefaults?.harnessType ?? null,
        runtimeDefaults?.model ?? null,
        cfg.updatedAt || new Date().toISOString(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/getBundle" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      const rows = sql
        .exec<{
          id: string;
          tools_json: string;
          mcp_json: string;
          secret_refs_json: string;
        }>(`SELECT * FROM access_bundles WHERE id = ?`, id)
        .toArray();
      const row = rows[0];
      if (!row) return Response.json(DEFAULT_BUNDLE);
      return Response.json({
        id: row.id,
        tools: JSON.parse(row.tools_json) as string[],
        mcpEndpoints: JSON.parse(row.mcp_json) as string[],
        secretRefs: JSON.parse(row.secret_refs_json) as string[],
      } satisfies AccessBundle);
    }

    if (url.pathname === "/putBundle" && request.method === "POST") {
      const bundle = (await request.json()) as AccessBundle;
      sql.exec(
        `INSERT INTO access_bundles (id, tools_json, mcp_json, secret_refs_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tools_json = excluded.tools_json,
           mcp_json = excluded.mcp_json,
           secret_refs_json = excluded.secret_refs_json`,
        bundle.id,
        JSON.stringify(bundle.tools),
        JSON.stringify(bundle.mcpEndpoints),
        JSON.stringify(bundle.secretRefs),
      );
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function loadTurnAccess(
  ns: DurableObjectNamespace<WorkspaceConfigDO>,
  teamId: string,
  channelId: string | undefined,
): Promise<{ config: WorkspaceChannelConfig; bundle: AccessBundle }> {
  const stub = ns.get(ns.idFromName(teamId));
  const config = (await stub
    .fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: channelId ?? null }),
    })
    .then((r) => r.json())) as WorkspaceChannelConfig;
  const bundle = (await stub
    .fetch("https://do/getBundle", {
      method: "POST",
      body: JSON.stringify({ id: config.accessBundleId }),
    })
    .then((r) => r.json())) as AccessBundle;
  return { config, bundle };
}
