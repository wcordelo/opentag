/**
 * Workspace / channel config Durable Object (PRODUCT.md Phase 2).
 *
 * Configuration authority split:
 *   - channelContext: Slack `/config` /putChannelContext
 *   - systemPromptOverlay: authenticated /putAdminConfig only
 * Historical system_prompt values migrate to channel_context only — never overlay.
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { SqlExecutor } from "../store/sql.js";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  type AccessBundle,
  type SystemPromptOverlay,
  type WorkspaceChannelConfig,
} from "./access-bundle.js";

export {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  resolveAllowedTools,
  type AccessBundle,
  type SystemPromptOverlay,
  type WorkspaceChannelConfig,
} from "./access-bundle.js";

const OVERLAY_MAX_BYTES = 64 * 1024;

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

type ChannelConfigRow = {
  team_id: string;
  channel_id: string;
  system_prompt: string;
  channel_context: string | null;
  system_prompt_overlay: string | null;
  system_prompt_overlay_version: number | null;
  system_prompt_overlay_digest: string | null;
  system_prompt_overlay_updated_at: string | null;
  policies_json: string;
  access_bundle_id: string;
  default_harness_type: string | null;
  default_model: string | null;
  updated_at: string;
};

function addColumnIfMissing(
  sql: SqlExecutor,
  columns: Set<string>,
  name: string,
  ddl: string,
): void {
  if (columns.has(name)) return;
  sql.exec(ddl);
  columns.add(name);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function rowChannelContext(row: ChannelConfigRow): string {
  if (typeof row.channel_context === "string" && row.channel_context.length > 0) {
    return row.channel_context;
  }
  return row.system_prompt || DEFAULT_SYSTEM_PROMPT;
}

function overlayMetaFromRow(
  row: ChannelConfigRow,
  includeText: boolean,
): SystemPromptOverlay | undefined {
  const text = row.system_prompt_overlay ?? "";
  const version = row.system_prompt_overlay_version ?? 0;
  const digest = row.system_prompt_overlay_digest ?? "";
  if (!text && version === 0 && !digest) return undefined;
  return {
    version: 1,
    revision: version,
    digest: digest ? (digest.startsWith("sha256:") ? digest : `sha256:${digest}`) : "",
    updatedAt: row.system_prompt_overlay_updated_at ?? row.updated_at,
    source: "workspace_admin",
    text: includeText ? text : "",
  };
}

function publicConfigFromRow(
  row: ChannelConfigRow,
  runtimeDefaults: WorkspaceChannelConfig["runtimeDefaults"],
  opts: { includeOverlayText: boolean },
): WorkspaceChannelConfig {
  const channelContext = rowChannelContext(row);
  const overlay = overlayMetaFromRow(row, opts.includeOverlayText);
  return {
    teamId: row.team_id,
    channelId: row.channel_id || null,
    channelContext,
    systemPrompt: channelContext,
    ...(overlay
      ? {
          systemPromptOverlay: opts.includeOverlayText
            ? overlay
            : {
                version: 1,
                revision: overlay.revision,
                digest: overlay.digest,
                updatedAt: overlay.updatedAt,
                source: "workspace_admin",
                text: "",
              },
        }
      : {}),
    policies: JSON.parse(row.policies_json) as WorkspaceChannelConfig["policies"],
    accessBundleId: row.access_bundle_id,
    runtimeDefaults,
    updatedAt: row.updated_at,
  };
}

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
    addColumnIfMissing(
      sql,
      columns,
      "default_harness_type",
      "ALTER TABLE channel_config ADD COLUMN default_harness_type TEXT",
    );
    addColumnIfMissing(
      sql,
      columns,
      "default_model",
      "ALTER TABLE channel_config ADD COLUMN default_model TEXT",
    );
    addColumnIfMissing(
      sql,
      columns,
      "channel_context",
      "ALTER TABLE channel_config ADD COLUMN channel_context TEXT NOT NULL DEFAULT ''",
    );
    addColumnIfMissing(
      sql,
      columns,
      "system_prompt_overlay",
      "ALTER TABLE channel_config ADD COLUMN system_prompt_overlay TEXT NOT NULL DEFAULT ''",
    );
    addColumnIfMissing(
      sql,
      columns,
      "system_prompt_overlay_version",
      "ALTER TABLE channel_config ADD COLUMN system_prompt_overlay_version INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      sql,
      columns,
      "system_prompt_overlay_digest",
      "ALTER TABLE channel_config ADD COLUMN system_prompt_overlay_digest TEXT NOT NULL DEFAULT ''",
    );
    addColumnIfMissing(
      sql,
      columns,
      "system_prompt_overlay_updated_at",
      "ALTER TABLE channel_config ADD COLUMN system_prompt_overlay_updated_at TEXT",
    );
    // Idempotent: copy legacy system_prompt → channel_context when empty.
    sql.exec(
      `UPDATE channel_config
       SET channel_context = system_prompt
       WHERE (channel_context IS NULL OR channel_context = '')
         AND system_prompt IS NOT NULL
         AND system_prompt != ''`,
    );
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

  private readRow(
    sql: SqlExecutor,
    teamId: string,
    channelKey: string,
  ): ChannelConfigRow | undefined {
    let rows = sql
      .exec<ChannelConfigRow>(
        `SELECT * FROM channel_config WHERE team_id = ? AND channel_id = ?`,
        teamId,
        channelKey,
      )
      .toArray();
    if (rows.length === 0 && channelKey !== "") {
      rows = sql
        .exec<ChannelConfigRow>(
          `SELECT * FROM channel_config WHERE team_id = ? AND channel_id = ''`,
          teamId,
        )
        .toArray();
    }
    return rows[0];
  }

  private runtimeDefaultsFor(
    row: ChannelConfigRow | undefined,
  ): WorkspaceChannelConfig["runtimeDefaults"] {
    if (!row) return undefined;
    try {
      return normalizeChannelRuntimeDefaults({
        harnessType: row.default_harness_type ?? undefined,
        model: row.default_model ?? undefined,
      });
    } catch (error) {
      console.warn(
        "[workspace-config] ignoring invalid stored runtime defaults",
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.migrate();
    const url = new URL(request.url);
    const sql = this.sql();

    if (url.pathname === "/getConfig" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
        includeOverlayText?: boolean;
      };
      const channelKey = body.channelId ?? "";
      const row = this.readRow(sql, body.teamId, channelKey);
      const runtimeDefaults = this.runtimeDefaultsFor(row);
      const config: WorkspaceChannelConfig = row
        ? publicConfigFromRow(row, runtimeDefaults, {
            includeOverlayText: body.includeOverlayText === true,
          })
        : {
            teamId: body.teamId,
            channelId: body.channelId ?? null,
            channelContext: DEFAULT_SYSTEM_PROMPT,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            policies: { allowMemoryWrite: true, allowTasks: true },
            accessBundleId: DEFAULT_BUNDLE.id,
            updatedAt: new Date().toISOString(),
          };
      return Response.json(config);
    }

    if (url.pathname === "/putChannelContext" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
        channelContext?: string;
        systemPrompt?: string;
        runtimeDefaults?: unknown;
        updatedAt?: string;
      };
      const unknown = Object.keys(body).filter(
        (key) =>
          ![
            "teamId",
            "channelId",
            "channelContext",
            "systemPrompt",
            "runtimeDefaults",
            "updatedAt",
          ].includes(key),
      );
      if (unknown.length > 0) {
        return Response.json(
          { error: `unknown field: ${unknown[0]}` },
          { status: 400 },
        );
      }
      if ("systemPromptOverlay" in (body as object)) {
        return Response.json(
          { error: "systemPromptOverlay_not_allowed" },
          { status: 400 },
        );
      }
      let runtimeDefaults;
      try {
        runtimeDefaults = normalizeChannelRuntimeDefaults(body.runtimeDefaults);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid runtime defaults" },
          { status: 400 },
        );
      }
      const channelKey = body.channelId ?? "";
      const channelContext =
        (typeof body.channelContext === "string" ? body.channelContext : undefined) ??
        (typeof body.systemPrompt === "string" ? body.systemPrompt : undefined) ??
        DEFAULT_SYSTEM_PROMPT;
      const existing = this.readRow(sql, body.teamId, channelKey);
      const updatedAt = body.updatedAt || new Date().toISOString();
      sql.exec(
        `INSERT INTO channel_config (
           team_id, channel_id, system_prompt, channel_context, policies_json, access_bundle_id,
           default_harness_type, default_model, updated_at,
           system_prompt_overlay, system_prompt_overlay_version, system_prompt_overlay_digest,
           system_prompt_overlay_updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, channel_id) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           channel_context = excluded.channel_context,
           default_harness_type = excluded.default_harness_type,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at`,
        body.teamId,
        channelKey,
        channelContext,
        channelContext,
        existing?.policies_json ?? "{}",
        existing?.access_bundle_id ?? DEFAULT_BUNDLE.id,
        runtimeDefaults !== undefined
          ? (runtimeDefaults?.harnessType ?? null)
          : (existing?.default_harness_type ?? null),
        runtimeDefaults !== undefined
          ? (runtimeDefaults?.model ?? null)
          : (existing?.default_model ?? null),
        updatedAt,
        existing?.system_prompt_overlay ?? "",
        existing?.system_prompt_overlay_version ?? 0,
        existing?.system_prompt_overlay_digest ?? "",
        existing?.system_prompt_overlay_updated_at ?? null,
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/putAdminConfig" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
        systemPromptOverlay?: {
          version?: number;
          revision?: number;
          text?: string;
          digest?: string;
          source?: string;
        };
        policies?: WorkspaceChannelConfig["policies"];
        accessBundleId?: string;
        runtimeDefaults?: unknown;
        expectedRevision?: number;
        updatedAt?: string;
      };
      const unknown = Object.keys(body).filter(
        (key) =>
          ![
            "teamId",
            "channelId",
            "systemPromptOverlay",
            "policies",
            "accessBundleId",
            "runtimeDefaults",
            "expectedRevision",
            "updatedAt",
          ].includes(key),
      );
      if (unknown.length > 0) {
        return Response.json(
          { error: `unknown field: ${unknown[0]}` },
          { status: 400 },
        );
      }
      let runtimeDefaults;
      try {
        runtimeDefaults = normalizeChannelRuntimeDefaults(body.runtimeDefaults);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid runtime defaults" },
          { status: 400 },
        );
      }
      const channelKey = body.channelId ?? "";
      const existing = this.readRow(sql, body.teamId, channelKey);
      const currentRevision = existing?.system_prompt_overlay_version ?? 0;
      if (
        typeof body.expectedRevision === "number" &&
        body.expectedRevision !== currentRevision
      ) {
        return Response.json(
          { error: "overlay_revision_conflict", currentRevision },
          { status: 409 },
        );
      }

      let overlayText = existing?.system_prompt_overlay ?? "";
      let overlayVersion = currentRevision;
      let overlayDigest = existing?.system_prompt_overlay_digest ?? "";
      let overlayUpdatedAt = existing?.system_prompt_overlay_updated_at ?? null;

      if (body.systemPromptOverlay) {
        const overlay = body.systemPromptOverlay;
        if (overlay.version !== undefined && overlay.version !== 1) {
          return Response.json({ error: "invalid_overlay_version" }, { status: 400 });
        }
        if (overlay.source !== undefined && overlay.source !== "workspace_admin") {
          return Response.json({ error: "invalid_overlay_source" }, { status: 400 });
        }
        const text = typeof overlay.text === "string" ? overlay.text : "";
        const trimmed = text.trim();
        if (text.length > 0 && trimmed.length === 0) {
          return Response.json({ error: "invalid_system_prompt_overlay" }, { status: 400 });
        }
        if (text.includes("\0")) {
          return Response.json({ error: "invalid_system_prompt_overlay" }, { status: 400 });
        }
        const encoded = new TextEncoder().encode(text);
        if (encoded.byteLength > OVERLAY_MAX_BYTES) {
          return Response.json({ error: "invalid_system_prompt_overlay" }, { status: 400 });
        }
        const digestHex = await sha256Hex(text);
        const digest = `sha256:${digestHex}`;
        if (overlay.digest && overlay.digest !== digest && overlay.digest !== digestHex) {
          return Response.json({ error: "overlay_digest_mismatch" }, { status: 400 });
        }
        overlayText = text;
        overlayVersion =
          typeof overlay.revision === "number" && Number.isSafeInteger(overlay.revision)
            ? overlay.revision
            : currentRevision + 1;
        if (overlayVersion < 0 || !Number.isSafeInteger(overlayVersion)) {
          return Response.json({ error: "invalid_overlay_revision" }, { status: 400 });
        }
        overlayDigest = digestHex;
        overlayUpdatedAt = new Date().toISOString();
      }

      const channelContext = existing
        ? rowChannelContext(existing)
        : DEFAULT_SYSTEM_PROMPT;
      const updatedAt = body.updatedAt || new Date().toISOString();
      sql.exec(
        `INSERT INTO channel_config (
           team_id, channel_id, system_prompt, channel_context, policies_json, access_bundle_id,
           default_harness_type, default_model, updated_at,
           system_prompt_overlay, system_prompt_overlay_version, system_prompt_overlay_digest,
           system_prompt_overlay_updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, channel_id) DO UPDATE SET
           policies_json = excluded.policies_json,
           access_bundle_id = excluded.access_bundle_id,
           default_harness_type = excluded.default_harness_type,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at,
           system_prompt_overlay = excluded.system_prompt_overlay,
           system_prompt_overlay_version = excluded.system_prompt_overlay_version,
           system_prompt_overlay_digest = excluded.system_prompt_overlay_digest,
           system_prompt_overlay_updated_at = excluded.system_prompt_overlay_updated_at`,
        body.teamId,
        channelKey,
        channelContext,
        channelContext,
        JSON.stringify(body.policies ?? (existing ? JSON.parse(existing.policies_json) : {})),
        body.accessBundleId || existing?.access_bundle_id || DEFAULT_BUNDLE.id,
        runtimeDefaults !== undefined
          ? (runtimeDefaults?.harnessType ?? null)
          : (existing?.default_harness_type ?? null),
        runtimeDefaults !== undefined
          ? (runtimeDefaults?.model ?? null)
          : (existing?.default_model ?? null),
        updatedAt,
        overlayText,
        overlayVersion,
        overlayDigest,
        overlayUpdatedAt,
      );
      return Response.json({
        ok: true,
        revision: overlayVersion,
        digest: overlayDigest ? `sha256:${overlayDigest}` : "",
      });
    }

    // Internal-only legacy path: preserves historical putConfig behavior for
    // channel context + policies/bundle/runtimeDefaults, but never accepts
    // overlay elevation through a broad object spread.
    if (url.pathname === "/putConfig" && request.method === "POST") {
      const cfg = (await request.json()) as WorkspaceChannelConfig & {
        systemPromptOverlay?: unknown;
      };
      if (cfg.systemPromptOverlay) {
        return Response.json(
          { error: "use_putAdminConfig_for_overlay" },
          { status: 400 },
        );
      }
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
      const channelContext =
        cfg.channelContext ?? cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const existing = this.readRow(sql, cfg.teamId, channelKey);
      const updatedAt = cfg.updatedAt || new Date().toISOString();
      sql.exec(
        `INSERT INTO channel_config (
           team_id, channel_id, system_prompt, channel_context, policies_json, access_bundle_id,
           default_harness_type, default_model, updated_at,
           system_prompt_overlay, system_prompt_overlay_version, system_prompt_overlay_digest,
           system_prompt_overlay_updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, channel_id) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           channel_context = excluded.channel_context,
           policies_json = excluded.policies_json,
           access_bundle_id = excluded.access_bundle_id,
           default_harness_type = excluded.default_harness_type,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at`,
        cfg.teamId,
        channelKey,
        channelContext,
        channelContext,
        JSON.stringify(cfg.policies ?? {}),
        cfg.accessBundleId || DEFAULT_BUNDLE.id,
        runtimeDefaults?.harnessType ?? null,
        runtimeDefaults?.model ?? null,
        updatedAt,
        existing?.system_prompt_overlay ?? "",
        existing?.system_prompt_overlay_version ?? 0,
        existing?.system_prompt_overlay_digest ?? "",
        existing?.system_prompt_overlay_updated_at ?? null,
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
  opts: { includeOverlayText?: boolean } = {},
): Promise<{ config: WorkspaceChannelConfig; bundle: AccessBundle }> {
  const stub = ns.get(ns.idFromName(teamId));
  const config = (await stub
    .fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: channelId ?? null,
        includeOverlayText: opts.includeOverlayText === true,
      }),
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
