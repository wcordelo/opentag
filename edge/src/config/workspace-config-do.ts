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
import {
  disabledTrackedKnowledgeSource,
  parseKnowledgeSourceScope,
  parsePutTrackedKnowledgeSource,
  type TrackedKnowledgeSource,
} from "./knowledge-config.js";
import {
  KNOWLEDGE_SOURCE_ACTIONS,
  parseKnowledgeSourceAdminRequest,
  type KnowledgeSourceAction,
  type VerifiedKnowledgeSourceGrant,
} from "./knowledge-source-authorization.js";

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
  // This is deliberately not channel_config: that table has an empty-channel
  // fallback and permissive synthesized defaults for turn configuration.
  `CREATE TABLE IF NOT EXISTS tracked_knowledge_sources (
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1)),
  reader_policy_ref TEXT NOT NULL DEFAULT '',
  retention_days INTEGER,
  config_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, project_id, channel_id)
)`,
  // sourceKey/customId and the B1 ledger are thread-scoped, not
  // project-qualified. Fail closed instead of allowing two enabled project
  // rows to race for the same (workspace, channel, thread) source.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_knowledge_one_enabled_project
   ON tracked_knowledge_sources(team_id, channel_id) WHERE enabled = 1`,
  `CREATE TABLE IF NOT EXISTS tracked_knowledge_effect_leases (
  effect_token TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  lease_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_tracked_knowledge_effect_scope
   ON tracked_knowledge_effect_leases(team_id, project_id, channel_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS tracked_knowledge_source_authorizations (
  grant_id TEXT PRIMARY KEY,
  artifact_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  issuer TEXT NOT NULL,
  key_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expected_config_version INTEGER,
  config_version_before INTEGER NOT NULL,
  config_version_after INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  consumed_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_tracked_knowledge_authorization_scope
   ON tracked_knowledge_source_authorizations(
     team_id, project_id, channel_id, consumed_at DESC
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

type TrackedKnowledgeSourceRow = {
  team_id: string;
  project_id: string;
  channel_id: string;
  enabled: number;
  ever_enabled: number;
  reader_policy_ref: string;
  retention_days: number | null;
  config_version: number;
  updated_at: string;
};

type TrackedKnowledgeAuthorizationRow = {
  grant_id: string;
  artifact_digest: string;
  issuer: string;
  key_id: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  issued_at: string;
  expires_at: string;
  expected_config_version: number | null;
  config_version_before: number;
  config_version_after: number;
  outcome: string;
  consumed_at: string;
};

function trackedKnowledgeSourceFromRow(row: TrackedKnowledgeSourceRow): TrackedKnowledgeSource {
  return {
    schemaVersion: 1,
    teamId: row.team_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    enabled: row.enabled === 1,
    everEnabled: row.ever_enabled === 1,
    readerPolicyRef: row.reader_policy_ref,
    retentionDays: row.retention_days,
    configVersion: row.config_version,
    updatedAt: row.updated_at,
  };
}

function trackedKnowledgeAuthorizationFromRow(row: TrackedKnowledgeAuthorizationRow) {
  return {
    grantId: row.grant_id,
    artifactDigest: row.artifact_digest,
    issuer: row.issuer,
    keyId: row.key_id,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
    },
    action: row.action,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    expectedConfigVersion: row.expected_config_version,
    configVersionBefore: row.config_version_before,
    configVersionAfter: row.config_version_after,
    outcome: row.outcome,
    consumedAt: row.consumed_at,
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
    const trackedColumns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(tracked_knowledge_sources)")
        .toArray()
        .map((row) => row.name),
    );
    if (!trackedColumns.has("ever_enabled")) {
      sql.exec(
        "ALTER TABLE tracked_knowledge_sources ADD COLUMN ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1))",
      );
      sql.exec("UPDATE tracked_knowledge_sources SET ever_enabled = 1 WHERE enabled = 1");
    }
    const effectColumns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(tracked_knowledge_effect_leases)")
        .toArray()
        .map((row) => row.name),
    );
    if (!effectColumns.has("lease_ms")) {
      sql.exec(
        "ALTER TABLE tracked_knowledge_effect_leases ADD COLUMN lease_ms INTEGER NOT NULL DEFAULT 80000",
      );
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
      const runtimeDefaultsProvided = "runtimeDefaults" in body;
      let runtimeDefaults: ReturnType<typeof normalizeChannelRuntimeDefaults>;
      if (runtimeDefaultsProvided) {
        try {
          runtimeDefaults = normalizeChannelRuntimeDefaults(body.runtimeDefaults);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "invalid runtime defaults" },
            { status: 400 },
          );
        }
      }
      const channelKey = body.channelId ?? "";
      const existing = this.readRow(sql, body.teamId, channelKey);
      const channelContextProvided =
        "channelContext" in body || "systemPrompt" in body;
      const channelContext = channelContextProvided
        ? ((typeof body.channelContext === "string" ? body.channelContext : undefined) ??
            (typeof body.systemPrompt === "string" ? body.systemPrompt : undefined) ??
            DEFAULT_SYSTEM_PROMPT)
        : existing
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
        runtimeDefaultsProvided
          ? (runtimeDefaults?.harnessType ?? null)
          : (existing?.default_harness_type ?? null),
        runtimeDefaultsProvided
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
      const runtimeDefaultsProvided = "runtimeDefaults" in body;
      let runtimeDefaults: ReturnType<typeof normalizeChannelRuntimeDefaults>;
      if (runtimeDefaultsProvided) {
        try {
          runtimeDefaults = normalizeChannelRuntimeDefaults(body.runtimeDefaults);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "invalid runtime defaults" },
            { status: 400 },
          );
        }
      }
      const channelKey = body.channelId ?? "";
      const existing = this.readRow(sql, body.teamId, channelKey);
      const currentRevision = existing?.system_prompt_overlay_version ?? 0;
      // Optimistic overlay CAS only applies when an overlay mutation is present.
      if (
        body.systemPromptOverlay &&
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
        JSON.stringify(
          body.policies ?? (existing ? JSON.parse(existing.policies_json) : {}),
        ),
        body.accessBundleId || existing?.access_bundle_id || DEFAULT_BUNDLE.id,
        runtimeDefaultsProvided
          ? (runtimeDefaults?.harnessType ?? null)
          : (existing?.default_harness_type ?? null),
        runtimeDefaultsProvided
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

    // Internal-only legacy path: channel context + runtime defaults only.
    // Policies, bundles, and overlays must use /putAdminConfig.
    if (url.pathname === "/putConfig" && request.method === "POST") {
      const cfg = (await request.json()) as WorkspaceChannelConfig & {
        systemPromptOverlay?: unknown;
        policies?: unknown;
        accessBundleId?: unknown;
      };
      if (cfg.systemPromptOverlay) {
        return Response.json(
          { error: "use_putAdminConfig_for_overlay" },
          { status: 400 },
        );
      }
      if (cfg.policies !== undefined || cfg.accessBundleId !== undefined) {
        return Response.json(
          { error: "use_putAdminConfig_for_policies" },
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
           default_harness_type = excluded.default_harness_type,
           default_model = excluded.default_model,
           updated_at = excluded.updated_at`,
        cfg.teamId,
        channelKey,
        channelContext,
        channelContext,
        existing?.policies_json ?? "{}",
        existing?.access_bundle_id ?? DEFAULT_BUNDLE.id,
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

    if (url.pathname === "/getTrackedKnowledgeSource" && request.method === "POST") {
      let scope;
      try {
        scope = parseKnowledgeSourceScope(await request.json());
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid tracked knowledge source scope" },
          { status: 400 },
        );
      }
      // There is intentionally no empty-channel/project fallback. A missing or
      // malformed record resolves to a disabled source and cannot enqueue.
      const row = sql
        .exec<TrackedKnowledgeSourceRow>(
          `SELECT * FROM tracked_knowledge_sources
           WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
          scope.teamId,
          scope.projectId,
          scope.channelId,
        )
        .toArray()[0];
      return Response.json(row ? trackedKnowledgeSourceFromRow(row) : disabledTrackedKnowledgeSource(scope));
    }

    if (url.pathname === "/listTrackedKnowledgeSources" && request.method === "POST") {
      let scope: { teamId: string; channelId: string };
      try {
        const input = await request.json() as { teamId?: unknown; channelId?: unknown };
        const parsed = parseKnowledgeSourceScope({
          teamId: input.teamId,
          projectId: "exact-channel-lookup",
          channelId: input.channelId,
        });
        scope = { teamId: parsed.teamId, channelId: parsed.channelId };
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid tracked knowledge source lookup" },
          { status: 400 },
        );
      }
      // Slack events contain no project id. Return only exact, explicitly
      // enabled rows for this team/channel; callers schedule one descriptor per
      // row and never infer a project or inherit the ordinary config fallback.
      const rows = sql.exec<TrackedKnowledgeSourceRow>(
        `SELECT * FROM tracked_knowledge_sources
         WHERE team_id = ? AND channel_id = ? AND enabled = 1
         ORDER BY project_id ASC`,
        scope.teamId,
        scope.channelId,
      ).toArray();
      return Response.json(rows.map(trackedKnowledgeSourceFromRow));
    }

    if (url.pathname === "/beginKnowledgeIngestionEffect" && request.method === "POST") {
      try {
        const input = await request.json() as {
          teamId?: unknown;
          projectId?: unknown;
          channelId?: unknown;
          configVersion?: unknown;
          effectToken?: unknown;
          leaseMs?: unknown;
          allowDisabled?: unknown;
        };
        const scope = parseKnowledgeSourceScope(input);
        if (!Number.isSafeInteger(input.configVersion) || (input.configVersion as number) < 1) {
          throw new Error("configVersion must be a positive integer");
        }
        if (typeof input.effectToken !== "string" || input.effectToken.length < 16 || input.effectToken.length > 128) {
          throw new Error("effectToken is invalid");
        }
        const leaseMs = input.leaseMs;
        if (!Number.isSafeInteger(leaseMs) || (leaseMs as number) < 1_000 || (leaseMs as number) > 5 * 60_000) {
          throw new Error("leaseMs must be between 1000 and 300000ms");
        }
        const nowMs = Date.now();
        const result = this.ctx.storage.transactionSync(() => {
          sql.exec("DELETE FROM tracked_knowledge_effect_leases WHERE expires_at <= ?", nowMs);
          const row = sql.exec<TrackedKnowledgeSourceRow>(
            `SELECT * FROM tracked_knowledge_sources
             WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
            scope.teamId,
            scope.projectId,
            scope.channelId,
          ).toArray()[0];
          if (!row || row.config_version !== input.configVersion ||
            (row.enabled !== 1 && input.allowDisabled !== true)) {
            return { decision: "stale" as const };
          }
          const expiresAt = nowMs + (leaseMs as number);
          sql.exec(
            `INSERT INTO tracked_knowledge_effect_leases (
               effect_token, team_id, project_id, channel_id, config_version,
               lease_ms, expires_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            input.effectToken as string,
            scope.teamId,
            scope.projectId,
            scope.channelId,
            input.configVersion as number,
            leaseMs as number,
            expiresAt,
            new Date(nowMs).toISOString(),
          );
          return {
            decision: "lease" as const,
            effectToken: input.effectToken as string,
            expiresAt,
            source: trackedKnowledgeSourceFromRow(row),
          };
        });
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid knowledge ingestion effect" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/validateKnowledgeIngestionEffect" && request.method === "POST") {
      try {
        const input = await request.json() as {
          teamId?: unknown;
          projectId?: unknown;
          channelId?: unknown;
          configVersion?: unknown;
          effectToken?: unknown;
          allowDisabled?: unknown;
        };
        const scope = parseKnowledgeSourceScope(input);
        if (!Number.isSafeInteger(input.configVersion) || (input.configVersion as number) < 1 ||
          typeof input.effectToken !== "string" || !input.effectToken) {
          throw new Error("knowledge ingestion effect identity is invalid");
        }
        const configVersion = input.configVersion as number;
        const effectToken = input.effectToken;
        const nowMs = Date.now();
        const result = this.ctx.storage.transactionSync(() => {
          sql.exec("DELETE FROM tracked_knowledge_effect_leases WHERE expires_at <= ?", nowMs);
          const effect = sql.exec<{
            config_version: number;
            lease_ms: number;
            expires_at: number;
          }>(
            `SELECT config_version, lease_ms, expires_at FROM tracked_knowledge_effect_leases
             WHERE effect_token = ? AND team_id = ? AND project_id = ? AND channel_id = ?`,
            effectToken,
            scope.teamId,
            scope.projectId,
            scope.channelId,
          ).toArray()[0];
          const row = sql.exec<TrackedKnowledgeSourceRow>(
            `SELECT * FROM tracked_knowledge_sources
             WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
            scope.teamId,
            scope.projectId,
            scope.channelId,
          ).toArray()[0];
          const valid = Boolean(
            effect &&
            row &&
            effect.expires_at > nowMs &&
            effect.config_version === configVersion &&
            row.config_version === configVersion &&
            (row.enabled === 1 || input.allowDisabled === true),
          );
          if (valid && effect) {
            sql.exec(
              "UPDATE tracked_knowledge_effect_leases SET expires_at = ? WHERE effect_token = ?",
              nowMs + effect.lease_ms,
              effectToken,
            );
          }
          return {
            valid,
            ...(valid && row ? { source: trackedKnowledgeSourceFromRow(row) } : {}),
          };
        });
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid knowledge ingestion effect validation" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/releaseKnowledgeIngestionEffect" && request.method === "POST") {
      const input = await request.json() as { effectToken?: unknown };
      if (typeof input.effectToken !== "string" || !input.effectToken) {
        return Response.json({ error: "effectToken is required" }, { status: 400 });
      }
      const existing = sql.exec<{ effect_token: string }>(
        "SELECT effect_token FROM tracked_knowledge_effect_leases WHERE effect_token = ?",
        input.effectToken,
      ).toArray()[0];
      sql.exec("DELETE FROM tracked_knowledge_effect_leases WHERE effect_token = ?", input.effectToken);
      return Response.json({ released: Boolean(existing) });
    }

    if (url.pathname === "/authorizedTrackedKnowledgeSourceAction" && request.method === "POST") {
      try {
        const body = await request.json() as {
          request?: Record<string, unknown>;
          grant?: Partial<VerifiedKnowledgeSourceGrant>;
        };
        const rawAction = body.request?.action;
        if (
          typeof rawAction !== "string" ||
          !(KNOWLEDGE_SOURCE_ACTIONS as readonly string[]).includes(rawAction)
        ) {
          throw new Error("tracked knowledge source action is invalid");
        }
        const action = rawAction as KnowledgeSourceAction;
        const rawRequest = {
          teamId: body.request?.teamId,
          projectId: body.request?.projectId,
          channelId: body.request?.channelId,
          expectedConfigVersion: body.request?.expectedConfigVersion,
          ...(action === "stage_disabled" || action === "update_disabled"
            ? {
              readerPolicyRef: body.request?.readerPolicyRef,
              retentionDays: body.request?.retentionDays,
            }
            : {}),
        };
        const sourceRequest = parseKnowledgeSourceAdminRequest(action, rawRequest);
        const grant = body.grant;
        if (
          !grant ||
          grant.version !== 1 ||
          grant.action !== action ||
          grant.teamId !== sourceRequest.teamId ||
          grant.projectId !== sourceRequest.projectId ||
          grant.channelId !== sourceRequest.channelId ||
          grant.expectedConfigVersion !== sourceRequest.expectedConfigVersion ||
          (grant.actorKind !== "human" && grant.actorKind !== "service") ||
          typeof grant.grantId !== "string" ||
          grant.grantId.length < 1 ||
          grant.grantId.length > 128 ||
          typeof grant.issuer !== "string" ||
          !grant.issuer ||
          typeof grant.keyId !== "string" ||
          !grant.keyId ||
          typeof grant.actorId !== "string" ||
          !grant.actorId ||
          typeof grant.requestDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(grant.requestDigest) ||
          typeof grant.artifactDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(grant.artifactDigest) ||
          typeof grant.issuedAt !== "string" ||
          typeof grant.expiresAt !== "string"
        ) {
          throw new Error("verified tracked knowledge source grant evidence is invalid");
        }
        const verifiedGrant = grant as VerifiedKnowledgeSourceGrant;

        const nowMs = Date.now();
        const consumedAt = new Date(nowMs).toISOString();
        const result = this.ctx.storage.transactionSync(() => {
          const priorAuthorization = sql.exec<TrackedKnowledgeAuthorizationRow>(
            `SELECT * FROM tracked_knowledge_source_authorizations WHERE grant_id = ?`,
            verifiedGrant.grantId,
          ).toArray()[0];
          if (priorAuthorization) {
            return {
              ok: false as const,
              status: 409,
              error: "knowledge_source_grant_replayed",
              authorization: trackedKnowledgeAuthorizationFromRow(priorAuthorization),
            };
          }

          sql.exec("DELETE FROM tracked_knowledge_effect_leases WHERE expires_at <= ?", nowMs);
          const before = sql.exec<TrackedKnowledgeSourceRow>(
            `SELECT * FROM tracked_knowledge_sources
             WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
            sourceRequest.teamId,
            sourceRequest.projectId,
            sourceRequest.channelId,
          ).toArray()[0];
          const configVersionBefore = before?.config_version ?? 0;
          let ok = true;
          let status = 200;
          let outcome = "authorized";

          if (Date.parse(verifiedGrant.expiresAt) <= nowMs) {
            ok = false;
            status = 409;
            outcome = "grant_expired_before_consume";
          } else if (
            sourceRequest.expectedConfigVersion !== null &&
            sourceRequest.expectedConfigVersion !== configVersionBefore
          ) {
            ok = false;
            status = 409;
            outcome = "stale_grant_config_version";
          }

          if (
            ok &&
            action !== "inspect" &&
            action !== "list_exact" &&
            action !== "stage_disabled"
          ) {
            const activeEffect = sql.exec<{ effect_token: string }>(
              `SELECT effect_token FROM tracked_knowledge_effect_leases
               WHERE team_id = ? AND project_id = ? AND channel_id = ? AND expires_at > ?
               LIMIT 1`,
              sourceRequest.teamId,
              sourceRequest.projectId,
              sourceRequest.channelId,
              nowMs,
            ).toArray()[0];
            if (activeEffect) {
              ok = false;
              status = 409;
              outcome = "active_ingestion_effect";
            }
          }

          if (ok && action === "stage_disabled") {
            if (before) {
              ok = false;
              status = 409;
              outcome = "source_already_exists";
            } else {
              sql.exec(
                `INSERT INTO tracked_knowledge_sources (
                   team_id, project_id, channel_id, enabled, ever_enabled,
                   reader_policy_ref, retention_days, config_version, updated_at
                 ) VALUES (?, ?, ?, 0, 0, ?, ?, 1, ?)`,
                sourceRequest.teamId,
                sourceRequest.projectId,
                sourceRequest.channelId,
                sourceRequest.readerPolicyRef ?? "",
                sourceRequest.retentionDays,
                consumedAt,
              );
            }
          } else if (ok && action === "update_disabled") {
            if (!before || before.enabled === 1 || before.ever_enabled === 1) {
              ok = false;
              status = 409;
              outcome = "disabled_staged_source_required";
            } else {
              sql.exec(
                `UPDATE tracked_knowledge_sources
                 SET reader_policy_ref = ?, retention_days = ?,
                     config_version = config_version + 1, updated_at = ?
                 WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
                sourceRequest.readerPolicyRef ?? "",
                sourceRequest.retentionDays,
                consumedAt,
                sourceRequest.teamId,
                sourceRequest.projectId,
                sourceRequest.channelId,
              );
            }
          } else if (ok && action === "enable_first") {
            if (!before || before.enabled === 1 || before.ever_enabled === 1) {
              ok = false;
              status = 409;
              outcome = "first_enable_transition_invalid";
            } else if (!before.reader_policy_ref) {
              ok = false;
              status = 409;
              outcome = "reader_policy_required_for_enable";
            } else {
              const conflict = sql.exec<{ project_id: string }>(
                `SELECT project_id FROM tracked_knowledge_sources
                 WHERE team_id = ? AND channel_id = ? AND enabled = 1 AND project_id <> ?
                 LIMIT 1`,
                sourceRequest.teamId,
                sourceRequest.channelId,
                sourceRequest.projectId,
              ).toArray()[0];
              if (conflict) {
                ok = false;
                status = 409;
                outcome = "conflicting_project_enabled";
              } else {
                sql.exec(
                  `UPDATE tracked_knowledge_sources
                   SET enabled = 1, ever_enabled = 1,
                       config_version = config_version + 1, updated_at = ?
                   WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
                  consumedAt,
                  sourceRequest.teamId,
                  sourceRequest.projectId,
                  sourceRequest.channelId,
                );
              }
            }
          } else if (ok && action === "disable") {
            if (!before || before.enabled !== 1) {
              ok = false;
              status = 409;
              outcome = "enabled_source_required";
            } else {
              sql.exec(
                `UPDATE tracked_knowledge_sources
                 SET enabled = 0, config_version = config_version + 1, updated_at = ?
                 WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
                consumedAt,
                sourceRequest.teamId,
                sourceRequest.projectId,
                sourceRequest.channelId,
              );
            }
          }

          const after = sql.exec<TrackedKnowledgeSourceRow>(
            `SELECT * FROM tracked_knowledge_sources
             WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
            sourceRequest.teamId,
            sourceRequest.projectId,
            sourceRequest.channelId,
          ).toArray()[0];
          const configVersionAfter = after?.config_version ?? configVersionBefore;
          sql.exec(
            `INSERT INTO tracked_knowledge_source_authorizations (
               grant_id, artifact_digest, request_digest, issuer, key_id,
               actor_kind, actor_id, action, team_id, project_id, channel_id,
               issued_at, expires_at, expected_config_version,
               config_version_before, config_version_after, outcome, consumed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            verifiedGrant.grantId,
            verifiedGrant.artifactDigest,
            verifiedGrant.requestDigest,
            verifiedGrant.issuer,
            verifiedGrant.keyId,
            verifiedGrant.actorKind,
            verifiedGrant.actorId,
            action,
            sourceRequest.teamId,
            sourceRequest.projectId,
            sourceRequest.channelId,
            verifiedGrant.issuedAt,
            verifiedGrant.expiresAt,
            verifiedGrant.expectedConfigVersion,
            configVersionBefore,
            configVersionAfter,
            outcome,
            consumedAt,
          );
          const authorizationRow = sql.exec<TrackedKnowledgeAuthorizationRow>(
            `SELECT * FROM tracked_knowledge_source_authorizations WHERE grant_id = ?`,
            verifiedGrant.grantId,
          ).toArray()[0];
          if (!authorizationRow) {
            throw new Error("tracked knowledge source authorization was not persisted");
          }
          const source = after
            ? trackedKnowledgeSourceFromRow(after)
            : disabledTrackedKnowledgeSource(sourceRequest);
          const authorizations = action === "list_exact"
            ? sql.exec<TrackedKnowledgeAuthorizationRow>(
              `SELECT * FROM tracked_knowledge_source_authorizations
               WHERE team_id = ? AND project_id = ? AND channel_id = ?
               ORDER BY consumed_at DESC LIMIT 50`,
              sourceRequest.teamId,
              sourceRequest.projectId,
              sourceRequest.channelId,
            ).toArray().map(trackedKnowledgeAuthorizationFromRow)
            : undefined;
          return {
            ok,
            status,
            ...(ok ? {} : { error: outcome }),
            source,
            ...(action === "list_exact"
              ? { sources: after ? [source] : [], authorizations }
              : {}),
            authorization: trackedKnowledgeAuthorizationFromRow(authorizationRow),
          };
        });
        return Response.json(result);
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error
              ? error.message
              : "invalid authorized tracked knowledge source action",
          },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/putTrackedKnowledgeSource" && request.method === "POST") {
      let source;
      try {
        source = parsePutTrackedKnowledgeSource(await request.json());
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid tracked knowledge source" },
          { status: 400 },
        );
      }
      const updatedAt = new Date().toISOString();
      const existingExact = sql.exec<TrackedKnowledgeSourceRow>(
        `SELECT * FROM tracked_knowledge_sources
         WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
        source.teamId,
        source.projectId,
        source.channelId,
      ).toArray()[0];
      const nowMs = Date.now();
      sql.exec("DELETE FROM tracked_knowledge_effect_leases WHERE expires_at <= ?", nowMs);
      const activeEffect = sql.exec<{ effect_token: string }>(
        `SELECT effect_token FROM tracked_knowledge_effect_leases
         WHERE team_id = ? AND project_id = ? AND channel_id = ? AND expires_at > ?
         LIMIT 1`,
        source.teamId,
        source.projectId,
        source.channelId,
        nowMs,
      ).toArray()[0];
      if (activeEffect) {
        return Response.json(
          { error: "tracked knowledge source has an active ingestion effect" },
          { status: 409 },
        );
      }
      // Local deletion/reindex semantics are not proven. Once an enabled row
      // is disabled, fail closed instead of allowing its old indexed document
      // to become authorized again under a later config version.
      if (source.enabled && existingExact && existingExact.enabled === 0 && existingExact.ever_enabled === 1) {
        return Response.json(
          { error: "tracked knowledge source re-enable requires a verified deletion/reindex contract" },
          { status: 409 },
        );
      }
      if (source.enabled) {
        const conflict = sql.exec<{ project_id: string }>(
          `SELECT project_id FROM tracked_knowledge_sources
           WHERE team_id = ? AND channel_id = ? AND enabled = 1 AND project_id <> ?
           LIMIT 1`,
          source.teamId,
          source.channelId,
          source.projectId,
        ).toArray()[0];
        if (conflict) {
          return Response.json(
            { error: "tracked knowledge channel already has a different enabled project" },
            { status: 409 },
          );
        }
      }
      // config_version is database-owned and strictly monotonic for this exact
      // (team, project, channel) key. This legacy binding-only RPC is not
      // exposed by the Worker; runtime administration uses the independently
      // verified one-use grant transaction above.
      try {
        sql.exec(
          `INSERT INTO tracked_knowledge_sources (
             team_id, project_id, channel_id, enabled, ever_enabled, reader_policy_ref,
             retention_days, config_version, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(team_id, project_id, channel_id) DO UPDATE SET
             enabled = excluded.enabled,
             ever_enabled = CASE
               WHEN tracked_knowledge_sources.ever_enabled = 1 OR excluded.enabled = 1 THEN 1
               ELSE 0
             END,
             reader_policy_ref = excluded.reader_policy_ref,
             retention_days = excluded.retention_days,
             config_version = tracked_knowledge_sources.config_version + 1,
             updated_at = excluded.updated_at`,
          source.teamId,
          source.projectId,
          source.channelId,
          source.enabled ? 1 : 0,
          source.enabled ? 1 : 0,
          source.readerPolicyRef,
          source.retentionDays ?? null,
          updatedAt,
        );
      } catch (error) {
        if (source.enabled && error instanceof Error && /unique/i.test(error.message)) {
          return Response.json(
            { error: "tracked knowledge channel already has a different enabled project" },
            { status: 409 },
          );
        }
        throw error;
      }
      const row = sql
        .exec<TrackedKnowledgeSourceRow>(
          `SELECT * FROM tracked_knowledge_sources
           WHERE team_id = ? AND project_id = ? AND channel_id = ?`,
          source.teamId,
          source.projectId,
          source.channelId,
        )
        .toArray()[0];
      if (!row) {
        return Response.json({ error: "tracked knowledge source write was not persisted" }, { status: 500 });
      }
      return Response.json(trackedKnowledgeSourceFromRow(row));
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
