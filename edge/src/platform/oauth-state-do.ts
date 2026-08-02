import { DurableObject } from "cloudflare:workers";
import type { SqlExecutor, TransactionRunner } from "../store/sql.js";
import {
  expiryFrom,
  hashOAuthSecret,
  nowIso,
  OAuthStateError,
  resolveAllowedRedirectOriginsEnv,
  randomOAuthSecret,
  validateOAuthStateConsumeRequest,
  validateOAuthStateIssueRequest,
  OAUTH_STATE_SCHEMA_VERSION,
  type OAuthStateConsumed,
  type OAuthStateIssueRequest,
  type OAuthStateIssued,
} from "./oauth-state.js";

const OAUTH_STATE_DDL = `CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  marketplace_version TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
)`;

export const OAUTH_STATE_OBJECT_NAME = "__oauth_state__";

type OAuthStateRow = {
  state_hash: string;
  nonce_hash: string;
  tenant_id: string;
  principal_id: string;
  connector_id: string;
  marketplace_version: string;
  redirect_uri: string;
  scopes_json: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export interface OAuthStateEngineDeps {
  sql: SqlExecutor;
  tx: TransactionRunner;
  allowedRedirectOrigins: readonly string[];
  now?: () => number;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
      throw new Error("invalid scopes");
    }
    return parsed;
  } catch {
    throw new OAuthStateError("oauth_state_corrupt", 503);
  }
}

function compare(value: string, expected: string, code: string): void {
  if (value !== expected) throw new OAuthStateError(code);
}

export class OAuthStateEngine {
  private readonly sql: SqlExecutor;
  private readonly tx: TransactionRunner;
  private readonly allowedRedirectOrigins: readonly string[];
  private readonly now: () => number;

  constructor(deps: OAuthStateEngineDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.allowedRedirectOrigins = deps.allowedRedirectOrigins;
    this.now = deps.now ?? (() => Date.now());
  }

  async issue(value: unknown): Promise<OAuthStateIssued> {
    const request = validateOAuthStateIssueRequest(value, this.allowedRedirectOrigins);
    const issuedAtMs = this.now();
    const issuedAt = nowIso(issuedAtMs);
    const ttlSeconds = request.ttlSeconds ?? 300;
    const expiresAt = expiryFrom(issuedAtMs, ttlSeconds);
    const state = randomOAuthSecret();
    const nonce = randomOAuthSecret();
    const [stateHash, nonceHash] = await Promise.all([
      hashOAuthSecret(state),
      hashOAuthSecret(nonce),
    ]);

    return this.tx(() => {
      const duplicate = this.sql.exec(
        `SELECT state_hash FROM oauth_states WHERE state_hash = ?`,
        stateHash,
      ).toArray()[0];
      if (duplicate) throw new OAuthStateError("oauth_state_collision", 503);
      this.sql.exec(
        `INSERT INTO oauth_states (
           state_hash, nonce_hash, tenant_id, principal_id, connector_id,
           marketplace_version, redirect_uri, scopes_json, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stateHash,
        nonceHash,
        request.tenantId,
        request.principalId,
        request.connectorId,
        request.marketplaceVersion,
        request.redirectUri,
        json(request.scopes),
        issuedAt,
        expiresAt,
      );
      return Object.freeze({
        schemaVersion: OAUTH_STATE_SCHEMA_VERSION,
        state,
        nonce,
        tenantId: request.tenantId,
        principalId: request.principalId,
        connectorId: request.connectorId,
        marketplaceVersion: request.marketplaceVersion,
        redirectUri: request.redirectUri,
        scopes: request.scopes,
        issuedAt,
        expiresAt,
      });
    });
  }

  async consume(value: unknown): Promise<OAuthStateConsumed> {
    const request = validateOAuthStateConsumeRequest(value, this.allowedRedirectOrigins);
    const [stateHash, nonceHash] = await Promise.all([
      hashOAuthSecret(request.state),
      hashOAuthSecret(request.nonce),
    ]);
    const consumedAt = nowIso(this.now());

    return this.tx(() => {
      const row = this.sql.exec<OAuthStateRow>(
        `SELECT * FROM oauth_states WHERE state_hash = ?`,
        stateHash,
      ).toArray()[0];
      if (!row) throw new OAuthStateError("oauth_state_not_found", 404);
      if (row.consumed_at) throw new OAuthStateError("oauth_state_replayed", 409);
      if (Date.parse(row.expires_at) <= Date.parse(consumedAt)) {
        throw new OAuthStateError("oauth_state_expired", 409);
      }
      compare(nonceHash, row.nonce_hash, "oauth_nonce_mismatch");
      compare(request.tenantId, row.tenant_id, "oauth_tenant_mismatch");
      compare(request.principalId, row.principal_id, "oauth_principal_mismatch");
      compare(request.connectorId, row.connector_id, "oauth_connector_mismatch");
      compare(request.marketplaceVersion, row.marketplace_version, "oauth_marketplace_version_mismatch");
      compare(request.redirectUri, row.redirect_uri, "oauth_redirect_uri_mismatch");

      this.sql.exec(
        `UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL`,
        consumedAt,
        stateHash,
      );
      return Object.freeze({
        schemaVersion: OAUTH_STATE_SCHEMA_VERSION,
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        connectorId: row.connector_id,
        marketplaceVersion: row.marketplace_version,
        redirectUri: row.redirect_uri,
        scopes: parseScopes(row.scopes_json),
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        consumedAt,
      });
    });
  }

  healthCheck(): { ok: true; storage: "sqlite" } {
    this.sql.exec(`SELECT 1 AS ok`).one();
    return { ok: true, storage: "sqlite" };
  }
}

function responseForError(error: unknown): Response {
  if (error instanceof OAuthStateError) return Response.json({ error: error.code }, { status: error.status });
  console.error("[oauth-state] request failed", error instanceof Error ? error.message : "unknown");
  return Response.json({ error: "oauth_state_internal_error" }, { status: 503 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new OAuthStateError("invalid_json");
  }
}

type OAuthStateEnv = {
  OAUTH_ALLOWED_REDIRECT_ORIGINS?: string;
};

export class OAuthStateDO extends DurableObject {
  private readonly engine: OAuthStateEngine;
  private readonly allowlistConfigValid: boolean;

  constructor(ctx: DurableObjectState, env: OAuthStateEnv) {
    super(ctx, env as never);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;
    void this.ctx.blockConcurrencyWhile(async () => {
      sql.exec(OAUTH_STATE_DDL);
    });
    const allowlist = resolveAllowedRedirectOriginsEnv(env.OAUTH_ALLOWED_REDIRECT_ORIGINS);
    this.allowlistConfigValid = allowlist.configValid;
    this.engine = new OAuthStateEngine({
      sql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
      allowedRedirectOrigins: allowlist.origins,
    });
  }

  healthCheck(): { ok: true; storage: "sqlite" } {
    if (!this.allowlistConfigValid) {
      throw new OAuthStateError("oauth_redirect_origins_invalid", 503);
    }
    return this.engine.healthCheck();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json(this.healthCheck());
      }
      if (url.pathname === "/issue" && request.method === "POST") {
        return Response.json(await this.engine.issue(await readJson(request)));
      }
      if (url.pathname === "/consume" && request.method === "POST") {
        return Response.json(await this.engine.consume(await readJson(request)));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return responseForError(error);
    }
  }
}
