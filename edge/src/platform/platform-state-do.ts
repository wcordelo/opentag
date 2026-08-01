import { DurableObject } from "cloudflare:workers";
import type {
  ConnectorMarketplaceEntry,
  ConnectorOAuthGrant,
  CredentialCustodyReference,
  IdentityCustodyReference,
  MemoryDeletionRequest,
  MemoryGovernancePolicy,
  PlatformEffectClaim,
  PlatformEffectIntent,
  PlatformEffectReceipt,
  PlatformEffectStatus,
  ProvisioningRequest,
  ProvisioningStatus,
  ProvisioningStep,
  UsageMeterEvent,
} from "./layer3-contract.js";
import {
  PlatformFoundationError,
  REQUIRED_PROVISIONING_STEPS,
  assertConnectorMarketplaceEntryActivatable,
  validateConnectorMarketplaceEntry,
  validateConnectorOAuthGrant,
  validateCredentialCustodyReference,
  validateIdentityCustodyReference,
  validateMemoryDeletionRequest,
  validateMemoryGovernancePolicy,
  validatePlatformEffectIntent,
  validateProvisioningRequest,
  validateUsageMeterEvent,
} from "./layer3-contract.js";
import type { SqlExecutor, TransactionRunner } from "../store/sql.js";

/**
 * Metadata-only platform state.
 *
 * This DO is the durable ledger behind the Layer 3 contracts. It records
 * ownership, versions, revocations, provisioning progress, usage receipts,
 * and memory-governance requests. It never receives provider tokens, private
 * keys, OAuth codes, prompt contents, or deletion payloads. The external
 * provisioning, custody, OAuth, billing, and memory workers remain separate
 * effectors and must explicitly advance this ledger.
 *
 * Tenant state is sharded by the deterministic internal tenant UUID derived
 * from the verified external tenant tuple. Marketplace metadata lives in one
 * reserved object because it is platform-wide rather than tenant-owned.
 */

export const PLATFORM_MARKETPLACE_OBJECT_NAME = "__platform_marketplace__";
export const PLATFORM_STATE_SCHEMA_VERSION = 1 as const;

const PLATFORM_DDL = [
  `CREATE TABLE IF NOT EXISTS provisioning (
     idempotency_key TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE,
     request_json TEXT NOT NULL,
     external_platform TEXT NOT NULL,
     external_tenant_id TEXT NOT NULL,
     requested_by_external_subject TEXT NOT NULL,
     tenant_id TEXT NOT NULL UNIQUE,
     isolation_mode TEXT NOT NULL,
     custody_backend TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('requested', 'provisioning', 'active', 'failed', 'suspended')),
     completed_steps_json TEXT NOT NULL DEFAULT '[]',
     failed_step TEXT,
     retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
     requested_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_provisioning_external
   ON provisioning(external_platform, external_tenant_id)`,
  `CREATE TABLE IF NOT EXISTS platform_effect_intents (
     intent_id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     scope TEXT NOT NULL CHECK (scope IN ('tenant', 'platform')),
     tenant_id TEXT,
     kind TEXT NOT NULL,
     target_ref TEXT NOT NULL,
     intent_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed', 'cancelled')),
     attempts INTEGER NOT NULL DEFAULT 0,
     retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
     available_at TEXT NOT NULL,
     lease_token TEXT,
     lease_owner TEXT,
     lease_expires_at TEXT,
     last_error_code TEXT,
     external_receipt_ref TEXT,
     requested_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     completed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_platform_effect_claimable
   ON platform_effect_intents(scope, tenant_id, status, available_at)`,
  `CREATE TABLE IF NOT EXISTS identity_custody_refs (
     identity_ref TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     backend TEXT NOT NULL,
     public_key TEXT NOT NULL,
     version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
     issued_at TEXT NOT NULL,
     revoked_at TEXT,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS credential_custody_refs (
     credential_ref TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     backend TEXT NOT NULL,
     provider TEXT NOT NULL,
     subject TEXT NOT NULL,
     scopes_json TEXT NOT NULL,
     version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
     issued_at TEXT NOT NULL,
     expires_at TEXT,
     revoked_at TEXT,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS marketplace_entries (
     connector_id TEXT NOT NULL,
     version TEXT NOT NULL,
     entry_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('curated', 'deprecated', 'revoked')),
     updated_at TEXT NOT NULL,
     PRIMARY KEY (connector_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS connector_oauth_grants (
     tenant_id TEXT NOT NULL,
     principal_id TEXT NOT NULL,
     connector_id TEXT NOT NULL,
     grant_json TEXT NOT NULL,
     credential_ref TEXT NOT NULL,
     version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
     issued_at TEXT NOT NULL,
     expires_at TEXT,
     revoked_at TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (tenant_id, principal_id, connector_id)
   )`,
  `CREATE TABLE IF NOT EXISTS usage_meter_events (
     idempotency_key TEXT PRIMARY KEY,
     event_id TEXT NOT NULL UNIQUE,
     event_json TEXT NOT NULL,
     tenant_id TEXT NOT NULL,
     execution_id TEXT NOT NULL,
     tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
     metric TEXT NOT NULL,
     quantity INTEGER NOT NULL,
     unit TEXT NOT NULL,
     plan_revision INTEGER NOT NULL,
     occurred_at TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_platform_meter_execution
   ON usage_meter_events(tenant_id, execution_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS memory_governance (
     tenant_id TEXT PRIMARY KEY,
     policy_json TEXT NOT NULL,
     deletion_epoch INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_deletion_requests (
     idempotency_key TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE,
     request_json TEXT NOT NULL,
     tenant_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('requested', 'accepted', 'completed', 'failed')),
     requested_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

function migratePlatformState(sql: SqlExecutor): void {
  for (const statement of PLATFORM_DDL) sql.exec(statement);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, code = "platform_state_corrupt"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new PlatformStateError(code, 503);
  }
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function id(value: unknown, code: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PlatformStateError(code, 400);
  }
  return value;
}

function positiveLimit(value: unknown, fallback = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new PlatformStateError("limit_invalid", 400);
  }
  return value as number;
}

function statusNumber(value: boolean): number {
  return value ? 1 : 0;
}

function stepsFromJson(value: string): ProvisioningStep[] {
  const parsed = parseJson<unknown[]>(value);
  if (!Array.isArray(parsed)) throw new PlatformStateError("platform_state_corrupt", 503);
  const allowed = new Set(REQUIRED_PROVISIONING_STEPS);
  const steps = parsed.filter(
    (step): step is ProvisioningStep => typeof step === "string" && allowed.has(step as ProvisioningStep),
  );
  if (steps.length !== parsed.length) throw new PlatformStateError("platform_state_corrupt", 503);
  return [...new Set(steps)];
}

function orderedSteps(steps: readonly ProvisioningStep[]): ProvisioningStep[] {
  const set = new Set(steps);
  return REQUIRED_PROVISIONING_STEPS.filter((step) => set.has(step));
}

function completedAll(steps: readonly ProvisioningStep[]): boolean {
  return REQUIRED_PROVISIONING_STEPS.every((step) => steps.includes(step));
}

function assertStatusTimestamps(
  status: "active" | "revoked",
  revokedAt: string | undefined,
  code: string,
): void {
  if (status === "active" && revokedAt !== undefined) {
    throw new PlatformStateError(`${code}_active_has_revocation`, 400);
  }
  if (status === "revoked" && revokedAt === undefined) {
    throw new PlatformStateError(`${code}_revoked_missing_revocation`, 400);
  }
}

function assertProvisionedRow(row: ProvisioningRow | undefined, tenantId: string): ProvisioningRow {
  if (!row) throw new PlatformStateError("tenant_not_provisioned", 409);
  if (row.tenant_id !== tenantId) throw new PlatformStateError("tenant_scope_mismatch", 409);
  if (row.status === "suspended") throw new PlatformStateError("tenant_suspended", 409);
  return row;
}

function assertTenantActive(row: ProvisioningRow | undefined, tenantId: string): ProvisioningRow {
  const provisioned = assertProvisionedRow(row, tenantId);
  if (provisioned.status !== "active") throw new PlatformStateError("tenant_not_active", 409);
  return provisioned;
}

export class PlatformStateError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503) {
    super(code);
    this.name = "PlatformStateError";
  }
}

/**
 * Derive the canonical internal tenant UUID without persisting the external
 * identifier in a global directory. The namespace is versioned so a future
 * migration can deliberately change the derivation rather than silently
 * moving a tenant to another Durable Object.
 */
export async function deriveInternalTenantId(input: Pick<
  ProvisioningRequest,
  "externalPlatform" | "externalTenantId"
>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `opentag:tenant:v${PLATFORM_STATE_SCHEMA_VERSION}:${input.externalPlatform}:${input.externalTenantId}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function platformTenantObjectName(tenantId: string): string {
  return `tenant:${id(tenantId, "tenant_id")}`;
}

type ProvisioningRow = {
  idempotency_key: string;
  request_id: string;
  request_json: string;
  external_platform: string;
  external_tenant_id: string;
  requested_by_external_subject: string;
  tenant_id: string;
  isolation_mode: string;
  custody_backend: string;
  status: ProvisioningStatus;
  completed_steps_json: string;
  failed_step: ProvisioningStep | null;
  retryable: number;
  requested_at: string;
  updated_at: string;
};

function provisioningReceipt(row: ProvisioningRow): {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  status: ProvisioningStatus;
  completedSteps: readonly ProvisioningStep[];
  failedStep?: ProvisioningStep;
  retryable: boolean;
  observedAt: string;
} {
  const completedSteps = orderedSteps(stepsFromJson(row.completed_steps_json));
  return {
    schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id,
    status: row.status,
    completedSteps,
    ...(row.failed_step ? { failedStep: row.failed_step } : {}),
    retryable: row.retryable === 1,
    observedAt: row.updated_at,
  };
}

type PlatformEffectRow = {
  intent_id: string;
  idempotency_key: string;
  scope: PlatformEffectIntent["scope"];
  tenant_id: string | null;
  kind: PlatformEffectIntent["kind"];
  target_ref: string;
  intent_json: string;
  status: PlatformEffectStatus;
  attempts: number;
  retryable: number;
  available_at: string;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  external_receipt_ref: string | null;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
};

function effectIntentFromRow(row: PlatformEffectRow): PlatformEffectIntent {
  try {
    return validatePlatformEffectIntent(parseJson<unknown>(row.intent_json));
  } catch (error) {
    if (error instanceof PlatformStateError) throw error;
    throw new PlatformStateError("platform_state_corrupt", 503);
  }
}

function effectReceipt(row: PlatformEffectRow): PlatformEffectReceipt {
  const intent = effectIntentFromRow(row);
  return {
    schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    scope: intent.scope,
    ...(intent.tenantId ? { tenantId: intent.tenantId } : {}),
    kind: intent.kind,
    targetRef: intent.targetRef,
    status: row.status,
    attempts: row.attempts,
    retryable: row.retryable === 1,
    availableAt: row.available_at,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.external_receipt_ref
      ? { externalReceiptRef: row.external_receipt_ref }
      : {}),
    requestedAt: intent.requestedAt,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function safeEffectErrorCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)
  ) {
    throw new PlatformStateError("effect_error_code_invalid", 400);
  }
  return value;
}

function effectLeaseSeconds(value: unknown): number {
  if (value === undefined) return 300;
  if (!Number.isSafeInteger(value) || (value as number) < 30 || (value as number) > 3_600) {
    throw new PlatformStateError("effect_lease_seconds_invalid", 400);
  }
  return value as number;
}

function effectRetryAfterSeconds(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 86_400) {
    throw new PlatformStateError("effect_retry_after_invalid", 400);
  }
  return value as number;
}

function leaseIsActive(row: PlatformEffectRow, now: string): boolean {
  return row.status === "leased" &&
    typeof row.lease_expires_at === "string" &&
    row.lease_expires_at > now;
}

export interface PlatformStateEngineDeps {
  sql: SqlExecutor;
  tx: TransactionRunner;
  now?: () => number;
}

export class PlatformStateEngine {
  private readonly sql: SqlExecutor;
  private readonly tx: TransactionRunner;
  private readonly now: () => number;

  constructor(deps: PlatformStateEngineDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Enqueue a provider handoff without accepting a provider payload or secret. */
  enqueueEffect(value: unknown): { ok: true; duplicate: boolean; receipt: PlatformEffectReceipt } {
    const intent = validatePlatformEffectIntent(value);
    const updatedAt = nowIso(this.now);
    return this.tx(() => this.insertEffectInTransaction(intent, updatedAt));
  }

  getEffect(value: unknown): PlatformEffectReceipt {
    const intentId = id(
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).intentId
        : value,
      "intent_id",
    );
    const row = this.effectById(intentId);
    if (!row) throw new PlatformStateError("effect_not_found", 404);
    return effectReceipt(row);
  }

  listEffects(value?: unknown): { effects: PlatformEffectReceipt[] } {
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const scope = input.scope === undefined
      ? undefined
      : input.scope === "tenant" || input.scope === "platform"
        ? input.scope
        : (() => { throw new PlatformStateError("effect_scope_invalid", 400); })();
    const tenantId = input.tenantId === undefined ? undefined : id(input.tenantId, "tenant_id");
    if (scope === "tenant" && !tenantId) {
      throw new PlatformStateError("effect_tenant_id_required", 400);
    }
    if (scope === "platform" && tenantId) {
      throw new PlatformStateError("effect_platform_tenant_forbidden", 400);
    }
    const rawStatus = input.status;
    const status = rawStatus === undefined
      ? undefined
      : rawStatus === "pending" ||
          rawStatus === "leased" ||
          rawStatus === "completed" ||
          rawStatus === "failed" ||
          rawStatus === "cancelled"
        ? rawStatus
        : (() => { throw new PlatformStateError("effect_status_invalid", 400); })();
    const limit = positiveLimit(input.limit);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (scope) {
      clauses.push("scope = ?");
      params.push(scope);
    }
    if (tenantId) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql.exec<PlatformEffectRow>(
      `SELECT * FROM platform_effect_intents ${where} ORDER BY updated_at ASC LIMIT ?`,
      ...params,
      limit,
    ).toArray();
    return { effects: rows.map(effectReceipt) };
  }

  /** Claim a pending or expired lease; the returned token is the only effect capability. */
  claimEffect(value: unknown): PlatformEffectClaim {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("effect_claim_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const intentId = id(input.intentId, "intent_id");
    const workerId = id(input.workerId, "worker_id");
    const leaseSeconds = effectLeaseSeconds(input.leaseSeconds);
    return this.tx(() => {
      const current = this.effectById(intentId);
      if (!current) throw new PlatformStateError("effect_not_found", 404);
      const now = nowIso(this.now);
      if (current.status === "completed" || current.status === "cancelled") {
        throw new PlatformStateError("effect_not_claimable", 409);
      }
      if (leaseIsActive(current, now)) {
        throw new PlatformStateError("effect_lease_active", 409);
      }
      if (current.status === "failed" && current.retryable !== 1) {
        throw new PlatformStateError("effect_failure_not_retryable", 409);
      }
      if (current.available_at > now) {
        throw new PlatformStateError("effect_not_available", 409);
      }
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAt = new Date(this.now() + leaseSeconds * 1_000).toISOString();
      this.sql.exec(
        `UPDATE platform_effect_intents
         SET status = 'leased', attempts = attempts + 1, lease_token = ?,
             lease_owner = ?, lease_expires_at = ?, last_error_code = NULL,
             updated_at = ?
         WHERE intent_id = ?`,
        leaseToken,
        workerId,
        leaseExpiresAt,
        now,
        intentId,
      );
      const updated = this.effectById(intentId)!;
      return {
        intent: effectIntentFromRow(updated),
        receipt: effectReceipt(updated),
        leaseToken,
        leaseOwner: workerId,
        leaseExpiresAt,
      };
    });
  }

  completeEffect(value: unknown): { ok: true; duplicate: boolean; receipt: PlatformEffectReceipt } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("effect_complete_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const intentId = id(input.intentId, "intent_id");
    const leaseToken = id(input.leaseToken, "lease_token", 256);
    const externalReceiptRef = input.externalReceiptRef === undefined
      ? undefined
      : id(input.externalReceiptRef, "external_receipt_ref");
    return this.tx(() => {
      const current = this.effectById(intentId);
      if (!current) throw new PlatformStateError("effect_not_found", 404);
      if (current.status === "completed") {
        return { ok: true, duplicate: true, receipt: effectReceipt(current) };
      }
      this.assertEffectLease(current, leaseToken);
      const completedAt = nowIso(this.now);
      this.sql.exec(
        `UPDATE platform_effect_intents
         SET status = 'completed', retryable = 0, lease_token = NULL,
             lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL,
             external_receipt_ref = ?, completed_at = ?, updated_at = ?
         WHERE intent_id = ?`,
        externalReceiptRef ?? null,
        completedAt,
        completedAt,
        intentId,
      );
      return { ok: true, duplicate: false, receipt: effectReceipt(this.effectById(intentId)!) };
    });
  }

  failEffect(value: unknown): { ok: true; receipt: PlatformEffectReceipt } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("effect_fail_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const intentId = id(input.intentId, "intent_id");
    const leaseToken = id(input.leaseToken, "lease_token", 256);
    const errorCode = safeEffectErrorCode(input.errorCode);
    if (typeof input.retryable !== "boolean") {
      throw new PlatformStateError("effect_retryable_invalid", 400);
    }
    const retryAfter = effectRetryAfterSeconds(input.retryAfterSeconds);
    return this.tx(() => {
      const current = this.effectById(intentId);
      if (!current) throw new PlatformStateError("effect_not_found", 404);
      this.assertEffectLease(current, leaseToken);
      const updatedAt = nowIso(this.now);
      const availableAt = new Date(this.now() + retryAfter * 1_000).toISOString();
      this.sql.exec(
        `UPDATE platform_effect_intents
         SET status = 'failed', retryable = ?, available_at = ?,
             lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = ?, external_receipt_ref = NULL, updated_at = ?
         WHERE intent_id = ?`,
        input.retryable ? 1 : 0,
        availableAt,
        errorCode,
        updatedAt,
        intentId,
      );
      return { ok: true, receipt: effectReceipt(this.effectById(intentId)!) };
    });
  }

  cancelEffect(value: unknown): { ok: true; duplicate: boolean; receipt: PlatformEffectReceipt } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("effect_cancel_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const intentId = id(input.intentId, "intent_id");
    const reasonCode = safeEffectErrorCode(input.reasonCode ?? "effect_cancelled");
    return this.tx(() => {
      const current = this.effectById(intentId);
      if (!current) throw new PlatformStateError("effect_not_found", 404);
      if (current.status === "cancelled") {
        return { ok: true, duplicate: true, receipt: effectReceipt(current) };
      }
      if (current.status === "completed") {
        throw new PlatformStateError("effect_already_completed", 409);
      }
      const updatedAt = nowIso(this.now);
      this.sql.exec(
        `UPDATE platform_effect_intents
         SET status = 'cancelled', retryable = 0, lease_token = NULL,
             lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?,
             updated_at = ?
         WHERE intent_id = ?`,
        reasonCode,
        updatedAt,
        intentId,
      );
      return { ok: true, duplicate: false, receipt: effectReceipt(this.effectById(intentId)!) };
    });
  }

  private insertEffectInTransaction(
    intent: PlatformEffectIntent,
    updatedAt: string,
  ): { ok: true; duplicate: boolean; receipt: PlatformEffectReceipt } {
    const intentJson = json(intent);
    const currentByKey = this.sql.exec<PlatformEffectRow>(
      `SELECT * FROM platform_effect_intents WHERE idempotency_key = ?`,
      intent.idempotencyKey,
    ).toArray()[0];
    if (currentByKey) {
      if (currentByKey.intent_json !== intentJson) {
        throw new PlatformStateError("effect_idempotency_conflict", 409);
      }
      return { ok: true, duplicate: true, receipt: effectReceipt(currentByKey) };
    }
    const currentById = this.effectById(intent.intentId);
    if (currentById) {
      throw new PlatformStateError("effect_intent_id_conflict", 409);
    }
    this.sql.exec(
      `INSERT INTO platform_effect_intents (
         intent_id, idempotency_key, scope, tenant_id, kind, target_ref,
         intent_json, status, attempts, retryable, available_at, lease_token,
         lease_owner, lease_expires_at, last_error_code, external_receipt_ref,
         requested_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      intent.intentId,
      intent.idempotencyKey,
      intent.scope,
      intent.tenantId ?? null,
      intent.kind,
      intent.targetRef,
      intentJson,
      updatedAt,
      intent.requestedAt,
      updatedAt,
    );
    return { ok: true, duplicate: false, receipt: effectReceipt(this.effectById(intent.intentId)!) };
  }

  async provision(value: unknown): Promise<ReturnType<typeof provisioningReceipt>> {
    const request = validateProvisioningRequest(value);
    const tenantId = await deriveInternalTenantId(request);
    const requestJson = json(request);
    return this.tx(() => {
      const existingKey = this.sql.exec<ProvisioningRow>(
        `SELECT * FROM provisioning WHERE idempotency_key = ?`,
        request.idempotencyKey,
      ).toArray()[0];
      if (existingKey) {
        if (existingKey.request_json !== requestJson) {
          throw new PlatformStateError("provisioning_idempotency_conflict", 409);
        }
        return provisioningReceipt(existingKey);
      }

      const existingExternal = this.sql.exec<ProvisioningRow>(
        `SELECT * FROM provisioning WHERE external_platform = ? AND external_tenant_id = ?`,
        request.externalPlatform,
        request.externalTenantId,
      ).toArray()[0];
      if (existingExternal) {
        throw new PlatformStateError("external_tenant_already_provisioned", 409);
      }
      const existingRequest = this.sql.exec<ProvisioningRow>(
        `SELECT * FROM provisioning WHERE request_id = ?`,
        request.requestId,
      ).toArray()[0];
      if (existingRequest) {
        throw new PlatformStateError("provisioning_request_id_conflict", 409);
      }

      const timestamp = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO provisioning (
           idempotency_key, request_id, request_json, external_platform,
           external_tenant_id, requested_by_external_subject, tenant_id,
           isolation_mode, custody_backend, status, completed_steps_json,
           failed_step, retryable, requested_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', '[]', NULL, 0, ?, ?)`,
        request.idempotencyKey,
        request.requestId,
        requestJson,
        request.externalPlatform,
        request.externalTenantId,
        request.requestedByExternalSubject,
        tenantId,
        request.isolationMode,
        request.custodyBackend,
        request.requestedAt,
        timestamp,
      );
      this.insertEffectInTransaction(
        validatePlatformEffectIntent({
          schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
          intentId: `effect:provisioning:${request.idempotencyKey}`,
          idempotencyKey: `provisioning:${request.idempotencyKey}`,
          scope: "tenant",
          tenantId,
          kind: "provisioning",
          targetRef: `provision:${request.idempotencyKey}`,
          metadata: {
            externalPlatform: request.externalPlatform,
            externalTenantId: request.externalTenantId,
            isolationMode: request.isolationMode,
            custodyBackend: request.custodyBackend,
            requestId: request.requestId,
          },
          requestedAt: request.requestedAt,
        }),
        timestamp,
      );
      return provisioningReceipt(this.provisioningByKey(request.idempotencyKey)!);
    });
  }

  getProvisioning(value: unknown): ReturnType<typeof provisioningReceipt> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("provisioning_lookup_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    let row: ProvisioningRow | undefined;
    if (input.idempotencyKey !== undefined) {
      row = this.provisioningByKey(id(input.idempotencyKey, "idempotency_key"));
    } else if (input.tenantId !== undefined) {
      row = this.sql.exec<ProvisioningRow>(
        `SELECT * FROM provisioning WHERE tenant_id = ?`,
        id(input.tenantId, "tenant_id"),
      ).toArray()[0];
    } else {
      throw new PlatformStateError("provisioning_lookup_key_required", 400);
    }
    if (!row) throw new PlatformStateError("provisioning_not_found", 404);
    return provisioningReceipt(row);
  }

  advanceProvisioning(value: unknown): ReturnType<typeof provisioningReceipt> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("provisioning_step_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const key = id(input.idempotencyKey, "idempotency_key");
    const step = input.step;
    if (!REQUIRED_PROVISIONING_STEPS.includes(step as ProvisioningStep)) {
      throw new PlatformStateError("provisioning_step_invalid", 400);
    }
    const outcome = input.outcome;
    if (outcome !== "complete" && outcome !== "failed") {
      throw new PlatformStateError("provisioning_step_outcome_invalid", 400);
    }
    if (input.retryable !== undefined && typeof input.retryable !== "boolean") {
      throw new PlatformStateError("provisioning_retryable_invalid", 400);
    }
    const retryable = input.retryable === true;

    return this.tx(() => {
      const current = this.provisioningByKey(key);
      if (!current) throw new PlatformStateError("provisioning_not_found", 404);
      const steps = stepsFromJson(current.completed_steps_json);
      const selectedStep = step as ProvisioningStep;

      if (outcome === "complete" && steps.includes(selectedStep)) {
        return provisioningReceipt(current);
      }
      if (current.status === "active") {
        throw new PlatformStateError("provisioning_already_active", 409);
      }
      if (current.status === "suspended") {
        throw new PlatformStateError("tenant_suspended", 409);
      }
      if (current.status === "failed" && current.retryable !== 1) {
        throw new PlatformStateError("provisioning_failure_not_retryable", 409);
      }

      const updatedAt = nowIso(this.now);
      let status: ProvisioningStatus;
      let completed = steps;
      let failedStep: ProvisioningStep | null = null;
      let nextRetryable = false;
      if (outcome === "failed") {
        status = "failed";
        failedStep = selectedStep;
        nextRetryable = retryable;
      } else {
        completed = orderedSteps([...steps, selectedStep]);
        status = completedAll(completed) ? "active" : "provisioning";
      }
      this.sql.exec(
        `UPDATE provisioning
         SET status = ?, completed_steps_json = ?, failed_step = ?, retryable = ?, updated_at = ?
         WHERE idempotency_key = ?`,
        status,
        json(completed),
        failedStep,
        status === "failed" ? statusNumber(nextRetryable) : 0,
        updatedAt,
        key,
      );
      return provisioningReceipt(this.provisioningByKey(key)!);
    });
  }

  putIdentity(value: unknown): { ok: true; duplicate: boolean; reference: IdentityCustodyReference } {
    const reference = validateIdentityCustodyReference(value);
    if (reference.status !== "active") {
      throw new PlatformStateError("identity_active_reference_required", 400);
    }
    assertStatusTimestamps(reference.status, reference.revokedAt, "identity");
    return this.tx(() => {
      const tenant = assertProvisionedRow(this.provisioningByTenant(reference.tenantId), reference.tenantId);
      if (tenant.custody_backend !== reference.backend) {
        throw new PlatformStateError("identity_custody_backend_mismatch", 409);
      }
      const current = this.sql.exec<IdentityRow>(
        `SELECT * FROM identity_custody_refs WHERE identity_ref = ?`,
        reference.identityRef,
      ).toArray()[0];
      if (current?.status === "revoked") throw new PlatformStateError("identity_revoked", 409);
      if (current && reference.version < current.version) {
        throw new PlatformStateError("identity_version_not_monotonic", 409);
      }
      if (current && reference.version === current.version) {
        if (JSON.stringify(identityFromRow(current)) !== JSON.stringify(reference)) {
          throw new PlatformStateError("identity_version_conflict", 409);
        }
        return { ok: true, duplicate: true, reference };
      }
      const updatedAt = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO identity_custody_refs (
           identity_ref, tenant_id, backend, public_key, version, status,
           issued_at, revoked_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?)
         ON CONFLICT(identity_ref) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           backend = excluded.backend,
           public_key = excluded.public_key,
           version = excluded.version,
           status = 'active',
           issued_at = excluded.issued_at,
           revoked_at = NULL,
           updated_at = excluded.updated_at`,
        reference.identityRef,
        reference.tenantId,
        reference.backend,
        reference.publicKey,
        reference.version,
        reference.issuedAt,
        updatedAt,
      );
      return { ok: true, duplicate: false, reference };
    });
  }

  getIdentity(value: unknown): IdentityCustodyReference {
    const identityRef = id(value, "identity_ref");
    const row = this.sql.exec<IdentityRow>(
      `SELECT * FROM identity_custody_refs WHERE identity_ref = ?`,
      identityRef,
    ).toArray()[0];
    if (!row) throw new PlatformStateError("identity_not_found", 404);
    return identityFromRow(row);
  }

  revokeIdentity(value: unknown): { ok: true; status: "revoked"; revokedAt: string } {
    const identityRef = id(value, "identity_ref");
    return this.tx(() => {
      const current = this.sql.exec<IdentityRow>(
        `SELECT * FROM identity_custody_refs WHERE identity_ref = ?`,
        identityRef,
      ).toArray()[0];
      if (!current) throw new PlatformStateError("identity_not_found", 404);
      if (current.status === "revoked") {
        return { ok: true, status: "revoked", revokedAt: current.revoked_at! };
      }
      const revokedAt = nowIso(this.now);
      this.sql.exec(
        `UPDATE identity_custody_refs SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE identity_ref = ?`,
        revokedAt,
        revokedAt,
        identityRef,
      );
      this.insertEffectInTransaction(
        validatePlatformEffectIntent({
          schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
          intentId: `effect:identity-revoke:${identityRef}:${current.version}`,
          idempotencyKey: `identity-revoke:${identityRef}:${current.version}`,
          scope: "tenant",
          tenantId: current.tenant_id,
          kind: "identity_custody",
          targetRef: identityRef,
          metadata: { operation: "revoke", version: current.version },
          requestedAt: revokedAt,
        }),
        revokedAt,
      );
      return { ok: true, status: "revoked", revokedAt };
    });
  }

  putCredential(value: unknown): { ok: true; duplicate: boolean; reference: CredentialCustodyReference } {
    const reference = validateCredentialCustodyReference(value);
    if (reference.status !== "active") {
      throw new PlatformStateError("credential_active_reference_required", 400);
    }
    assertStatusTimestamps(reference.status, reference.revokedAt, "credential");
    return this.tx(() => {
      const tenant = assertProvisionedRow(this.provisioningByTenant(reference.tenantId), reference.tenantId);
      if (tenant.custody_backend !== reference.backend) {
        throw new PlatformStateError("credential_custody_backend_mismatch", 409);
      }
      const current = this.sql.exec<CredentialRow>(
        `SELECT * FROM credential_custody_refs WHERE credential_ref = ?`,
        reference.credentialRef,
      ).toArray()[0];
      if (current?.status === "revoked") throw new PlatformStateError("credential_revoked", 409);
      if (current && reference.version < current.version) {
        throw new PlatformStateError("credential_version_not_monotonic", 409);
      }
      if (current && reference.version === current.version) {
        if (JSON.stringify(credentialFromRow(current)) !== JSON.stringify(reference)) {
          throw new PlatformStateError("credential_version_conflict", 409);
        }
        return { ok: true, duplicate: true, reference };
      }
      const updatedAt = nowIso(this.now);
      if (current && reference.version > current.version) {
        this.revokeOAuthGrantsForCredential(reference.credentialRef, updatedAt, "credential_rotation");
        this.insertEffectInTransaction(
          validatePlatformEffectIntent({
            schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
            intentId: `effect:credential-rotate:${reference.credentialRef}:${reference.version}`,
            idempotencyKey: `credential-rotate:${reference.credentialRef}:${reference.version}`,
            scope: "tenant",
            tenantId: reference.tenantId,
            kind: "credential_custody",
            targetRef: reference.credentialRef,
            metadata: {
              operation: "rotate",
              previousVersion: current.version,
              provider: reference.provider,
              version: reference.version,
            },
            requestedAt: reference.issuedAt,
          }),
          updatedAt,
        );
      }
      this.sql.exec(
        `INSERT INTO credential_custody_refs (
           credential_ref, tenant_id, backend, provider, subject, scopes_json,
           version, status, issued_at, expires_at, revoked_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)
         ON CONFLICT(credential_ref) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           backend = excluded.backend,
           provider = excluded.provider,
           subject = excluded.subject,
           scopes_json = excluded.scopes_json,
           version = excluded.version,
           status = 'active',
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           revoked_at = NULL,
           updated_at = excluded.updated_at`,
        reference.credentialRef,
        reference.tenantId,
        reference.backend,
        reference.provider,
        reference.subject,
        json(reference.scopes),
        reference.version,
        reference.issuedAt,
        reference.expiresAt ?? null,
        updatedAt,
      );
      return { ok: true, duplicate: false, reference };
    });
  }

  getCredential(value: unknown): CredentialCustodyReference {
    const credentialRef = id(value, "credential_ref");
    const row = this.sql.exec<CredentialRow>(
      `SELECT * FROM credential_custody_refs WHERE credential_ref = ?`,
      credentialRef,
    ).toArray()[0];
    if (!row) throw new PlatformStateError("credential_not_found", 404);
    return credentialFromRow(row);
  }

  revokeCredential(value: unknown): { ok: true; status: "revoked"; revokedAt: string } {
    const credentialRef = id(value, "credential_ref");
    return this.tx(() => {
      const current = this.sql.exec<CredentialRow>(
        `SELECT * FROM credential_custody_refs WHERE credential_ref = ?`,
        credentialRef,
      ).toArray()[0];
      if (!current) throw new PlatformStateError("credential_not_found", 404);
      if (current.status === "revoked") {
        return { ok: true, status: "revoked", revokedAt: current.revoked_at! };
      }
      const revokedAt = nowIso(this.now);
      this.revokeOAuthGrantsForCredential(credentialRef, revokedAt, "credential_revocation");
      this.sql.exec(
        `UPDATE credential_custody_refs SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE credential_ref = ?`,
        revokedAt,
        revokedAt,
        credentialRef,
      );
      this.insertEffectInTransaction(
        validatePlatformEffectIntent({
          schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
          intentId: `effect:credential-revoke:${credentialRef}:${current.version}`,
          idempotencyKey: `credential-revoke:${credentialRef}:${current.version}`,
          scope: "tenant",
          tenantId: current.tenant_id,
          kind: "credential_custody",
          targetRef: credentialRef,
          metadata: {
            operation: "revoke",
            provider: current.provider,
            version: current.version,
          },
          requestedAt: revokedAt,
        }),
        revokedAt,
      );
      return { ok: true, status: "revoked", revokedAt };
    });
  }

  putMarketplace(value: unknown): { ok: true; duplicate: boolean; entry: ConnectorMarketplaceEntry } {
    const entry = validateConnectorMarketplaceEntry(value);
    assertConnectorMarketplaceEntryActivatable(entry);
    if (entry.status === "revoked") {
      throw new PlatformStateError("marketplace_active_entry_required", 400);
    }
    return this.tx(() => {
      const current = this.sql.exec<MarketplaceRow>(
        `SELECT * FROM marketplace_entries WHERE connector_id = ? AND version = ?`,
        entry.connectorId,
        entry.version,
      ).toArray()[0];
      const entryJson = json(entry);
      if (current) {
        if (current.entry_json !== entryJson) throw new PlatformStateError("marketplace_version_conflict", 409);
        return { ok: true, duplicate: true, entry };
      }
      const updatedAt = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO marketplace_entries (connector_id, version, entry_json, status, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        entry.connectorId,
        entry.version,
        entryJson,
        entry.status,
        updatedAt,
      );
      this.insertMarketplaceEffect(entry, updatedAt, entry.status === "deprecated" ? "deprecate" : "curate");
      return { ok: true, duplicate: false, entry };
    });
  }

  listMarketplace(value?: unknown): { entries: ConnectorMarketplaceEntry[] } {
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const connectorId = input.connectorId === undefined
      ? undefined
      : id(input.connectorId, "connector_id");
    const limit = positiveLimit(input.limit);
    const rows = connectorId
      ? this.sql.exec<MarketplaceRow>(
        `SELECT * FROM marketplace_entries WHERE connector_id = ? ORDER BY version DESC LIMIT ?`,
        connectorId,
        limit,
      ).toArray()
      : this.sql.exec<MarketplaceRow>(
        `SELECT * FROM marketplace_entries ORDER BY updated_at DESC LIMIT ?`,
        limit,
      ).toArray();
    return { entries: rows.map(marketplaceFromRow) };
  }

  revokeMarketplace(value: unknown): { ok: true; status: "revoked"; updatedAt: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("marketplace_lookup_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const connectorId = id(input.connectorId, "connector_id");
    const version = id(input.version, "version");
    return this.tx(() => {
      const current = this.sql.exec<MarketplaceRow>(
        `SELECT * FROM marketplace_entries WHERE connector_id = ? AND version = ?`,
        connectorId,
        version,
      ).toArray()[0];
      if (!current) throw new PlatformStateError("marketplace_not_found", 404);
      if (current.status === "revoked") {
        return { ok: true, status: "revoked", updatedAt: current.updated_at };
      }
      const entry = marketplaceFromRow(current);
      const revoked = validateConnectorMarketplaceEntry({ ...entry, status: "revoked" });
      const updatedAt = nowIso(this.now);
      this.revokeOAuthGrantsForMarketplace(
        entry.connectorId,
        entry.version,
        updatedAt,
      );
      this.sql.exec(
        `UPDATE marketplace_entries SET entry_json = ?, status = 'revoked', updated_at = ?
         WHERE connector_id = ? AND version = ?`,
        json(revoked),
        updatedAt,
        connectorId,
        version,
      );
      this.insertMarketplaceEffect(revoked, updatedAt, "revoke");
      return { ok: true, status: "revoked", updatedAt };
    });
  }

  putOAuthGrant(value: unknown): { ok: true; duplicate: boolean; grant: ConnectorOAuthGrant } {
    const grant = validateConnectorOAuthGrant(value);
    if (grant.status !== "active") throw new PlatformStateError("oauth_active_grant_required", 400);
    return this.tx(() => {
      assertTenantActive(this.provisioningByTenant(grant.tenantId), grant.tenantId);
      const marketplace = this.sql.exec<MarketplaceRow>(
        `SELECT * FROM marketplace_entries WHERE connector_id = ? AND version = ?`,
        grant.connectorId,
        grant.marketplaceVersion,
      ).toArray()[0];
      if (!marketplace) throw new PlatformStateError("oauth_marketplace_not_found", 409);
      const marketplaceEntry = marketplaceFromRow(marketplace);
      if (marketplaceEntry.status !== "curated") {
        throw new PlatformStateError("oauth_marketplace_not_curated", 409);
      }
      if (marketplaceEntry.authMode !== "oauth2") {
        throw new PlatformStateError("oauth_connector_not_oauth2", 409);
      }
      if (grant.scopes.some((scope) => !marketplaceEntry.oauthScopes.includes(scope))) {
        throw new PlatformStateError("oauth_scope_not_allowed", 409);
      }
      const credential = this.sql.exec<CredentialRow>(
        `SELECT * FROM credential_custody_refs WHERE credential_ref = ?`,
        grant.credentialRef,
      ).toArray()[0];
      if (!credential) throw new PlatformStateError("oauth_credential_not_found", 409);
      if (credential.tenant_id !== grant.tenantId) throw new PlatformStateError("oauth_credential_scope_mismatch", 409);
      if (credential.status !== "active") throw new PlatformStateError("oauth_credential_revoked", 409);
      if (credential.provider !== marketplaceEntry.provider) {
        throw new PlatformStateError("oauth_provider_mismatch", 409);
      }
      const current = this.sql.exec<OAuthRow>(
        `SELECT * FROM connector_oauth_grants
         WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
        grant.tenantId,
        grant.principalId,
        grant.connectorId,
      ).toArray()[0];
      const grantJson = json(grant);
      if (current?.status === "revoked") throw new PlatformStateError("oauth_grant_revoked", 409);
      if (current && grant.version < current.version) throw new PlatformStateError("oauth_version_not_monotonic", 409);
      if (current && grant.version === current.version) {
        if (current.grant_json !== grantJson) throw new PlatformStateError("oauth_version_conflict", 409);
        return { ok: true, duplicate: true, grant };
      }
      const updatedAt = nowIso(this.now);
      if (current && grant.version > current.version) {
        this.insertOAuthRevokeEffect(
          parseJson<ConnectorOAuthGrant>(current.grant_json),
          updatedAt,
          "grant_rotation",
        );
      }
      this.sql.exec(
        `INSERT INTO connector_oauth_grants (
           tenant_id, principal_id, connector_id, grant_json, credential_ref,
           version, status, issued_at, expires_at, revoked_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(tenant_id, principal_id, connector_id) DO UPDATE SET
           grant_json = excluded.grant_json,
           credential_ref = excluded.credential_ref,
           version = excluded.version,
           status = excluded.status,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           revoked_at = NULL,
           updated_at = excluded.updated_at`,
        grant.tenantId,
        grant.principalId,
        grant.connectorId,
        grantJson,
        grant.credentialRef,
        grant.version,
        grant.status,
        grant.issuedAt,
        grant.expiresAt ?? null,
        updatedAt,
      );
      return { ok: true, duplicate: false, grant };
    });
  }

  getOAuthGrant(value: unknown): ConnectorOAuthGrant {
    const key = oauthKey(value);
    const row = this.sql.exec<OAuthRow>(
      `SELECT * FROM connector_oauth_grants WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
      key.tenantId,
      key.principalId,
      key.connectorId,
    ).toArray()[0];
    if (!row) throw new PlatformStateError("oauth_grant_not_found", 404);
    return parseJson<ConnectorOAuthGrant>(row.grant_json);
  }

  revokeOAuthGrant(value: unknown): { ok: true; status: "revoked"; revokedAt: string } {
    const key = oauthKey(value);
    return this.tx(() => {
      const current = this.sql.exec<OAuthRow>(
        `SELECT * FROM connector_oauth_grants WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
        key.tenantId,
        key.principalId,
        key.connectorId,
      ).toArray()[0];
      if (!current) throw new PlatformStateError("oauth_grant_not_found", 404);
      if (current.status === "revoked") {
        return { ok: true, status: "revoked", revokedAt: current.revoked_at! };
      }
      const revokedAt = nowIso(this.now);
      const grant = parseJson<ConnectorOAuthGrant>(current.grant_json);
      const revoked = {
        ...grant,
        status: "revoked" as const,
        revokedAt,
      };
      this.sql.exec(
        `UPDATE connector_oauth_grants SET grant_json = ?, status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
        json(revoked),
        revokedAt,
        revokedAt,
        key.tenantId,
        key.principalId,
        key.connectorId,
      );
      this.insertOAuthRevokeEffect(grant, revokedAt, "explicit_revoke");
      return { ok: true, status: "revoked", revokedAt };
    });
  }

  recordMeter(value: unknown): { ok: true; duplicate: boolean; event: UsageMeterEvent } {
    const event = validateUsageMeterEvent(value);
    const expectedUnit = event.metric === "agent_tokens"
      ? "tokens"
      : event.metric === "container_ms"
        ? "milliseconds"
        : "count";
    if (event.unit !== expectedUnit) throw new PlatformStateError("usage_unit_mismatch", 400);
    return this.tx(() => {
      assertTenantActive(this.provisioningByTenant(event.tenantId), event.tenantId);
      const current = this.sql.exec<MeterRow>(
        `SELECT * FROM usage_meter_events WHERE idempotency_key = ?`,
        event.idempotencyKey,
      ).toArray()[0];
      const eventJson = json(event);
      if (current) {
        if (current.event_json !== eventJson) throw new PlatformStateError("usage_idempotency_conflict", 409);
        return { ok: true, duplicate: true, event };
      }
      const sameEvent = this.sql.exec<MeterRow>(
        `SELECT * FROM usage_meter_events WHERE event_id = ?`,
        event.eventId,
      ).toArray()[0];
      if (sameEvent) throw new PlatformStateError("usage_event_id_conflict", 409);
      const recordedAt = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO usage_meter_events (
           idempotency_key, event_id, event_json, tenant_id, execution_id,
           tier, metric, quantity, unit, plan_revision, occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.idempotencyKey,
        event.eventId,
        eventJson,
        event.tenantId,
        event.executionId,
        event.tier,
        event.metric,
        event.quantity,
        event.unit,
        event.planRevision,
        event.occurredAt,
        recordedAt,
      );
      this.insertEffectInTransaction(
        validatePlatformEffectIntent({
          schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
          intentId: `effect:billing-meter:${event.idempotencyKey}`,
          idempotencyKey: `billing-meter:${event.idempotencyKey}`,
          scope: "tenant",
          tenantId: event.tenantId,
          kind: "billing_meter",
          targetRef: event.eventId,
          metadata: {
            executionId: event.executionId,
            metric: event.metric,
            planRevision: event.planRevision,
            quantity: event.quantity,
            tier: event.tier,
            unit: event.unit,
          },
          requestedAt: event.occurredAt,
        }),
        recordedAt,
      );
      return { ok: true, duplicate: false, event };
    });
  }

  listMeter(value: unknown): { events: UsageMeterEvent[] } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlatformStateError("meter_lookup_invalid", 400);
    }
    const input = value as Record<string, unknown>;
    const tenantId = id(input.tenantId, "tenant_id");
    const executionId = input.executionId === undefined ? undefined : id(input.executionId, "execution_id");
    const limit = positiveLimit(input.limit);
    const rows = executionId
      ? this.sql.exec<MeterRow>(
        `SELECT * FROM usage_meter_events WHERE tenant_id = ? AND execution_id = ? ORDER BY occurred_at ASC LIMIT ?`,
        tenantId,
        executionId,
        limit,
      ).toArray()
      : this.sql.exec<MeterRow>(
        `SELECT * FROM usage_meter_events WHERE tenant_id = ? ORDER BY occurred_at ASC LIMIT ?`,
        tenantId,
        limit,
      ).toArray();
    return { events: rows.map((row) => parseJson<UsageMeterEvent>(row.event_json)) };
  }

  putMemoryPolicy(value: unknown): { ok: true; duplicate: boolean; policy: MemoryGovernancePolicy } {
    const policy = validateMemoryGovernancePolicy(value);
    return this.tx(() => {
      assertProvisionedRow(this.provisioningByTenant(policy.tenantId), policy.tenantId);
      const current = this.sql.exec<MemoryPolicyRow>(
        `SELECT * FROM memory_governance WHERE tenant_id = ?`,
        policy.tenantId,
      ).toArray()[0];
      if (current && policy.deletionEpoch < current.deletion_epoch) {
        throw new PlatformStateError("memory_deletion_epoch_regressed", 409);
      }
      const policyJson = json(policy);
      if (current && current.policy_json === policyJson) {
        return { ok: true, duplicate: true, policy };
      }
      if (current && policy.deletionEpoch === current.deletion_epoch) {
        throw new PlatformStateError("memory_deletion_epoch_must_advance", 409);
      }
      const updatedAt = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO memory_governance (tenant_id, policy_json, deletion_epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           deletion_epoch = excluded.deletion_epoch,
           updated_at = excluded.updated_at`,
        policy.tenantId,
        policyJson,
        policy.deletionEpoch,
        updatedAt,
      );
      return { ok: true, duplicate: false, policy };
    });
  }

  getMemoryPolicy(value: unknown): MemoryGovernancePolicy {
    const tenantId = id(value, "tenant_id");
    const row = this.sql.exec<MemoryPolicyRow>(
      `SELECT * FROM memory_governance WHERE tenant_id = ?`,
      tenantId,
    ).toArray()[0];
    if (!row) throw new PlatformStateError("memory_policy_not_found", 404);
    return parseJson<MemoryGovernancePolicy>(row.policy_json);
  }

  requestMemoryDeletion(value: unknown): { ok: true; duplicate: boolean; status: "requested"; request: MemoryDeletionRequest } {
    const request = validateMemoryDeletionRequest(value);
    return this.tx(() => {
      assertTenantActive(this.provisioningByTenant(request.tenantId), request.tenantId);
      const policy = this.sql.exec<MemoryPolicyRow>(
        `SELECT * FROM memory_governance WHERE tenant_id = ?`,
        request.tenantId,
      ).toArray()[0];
      if (!policy) throw new PlatformStateError("memory_policy_required", 409);
      if (request.deletionEpoch !== policy.deletion_epoch) {
        throw new PlatformStateError("memory_deletion_epoch_stale", 409);
      }
      const requestJson = json(request);
      const current = this.sql.exec<DeletionRow>(
        `SELECT * FROM memory_deletion_requests WHERE idempotency_key = ?`,
        request.idempotencyKey,
      ).toArray()[0];
      if (current) {
        if (current.request_json !== requestJson) throw new PlatformStateError("memory_deletion_idempotency_conflict", 409);
        return { ok: true, duplicate: true, status: "requested", request };
      }
      const sameRequest = this.sql.exec<DeletionRow>(
        `SELECT * FROM memory_deletion_requests WHERE request_id = ?`,
        request.requestId,
      ).toArray()[0];
      if (sameRequest) throw new PlatformStateError("memory_deletion_request_id_conflict", 409);
      const updatedAt = nowIso(this.now);
      this.sql.exec(
        `INSERT INTO memory_deletion_requests (
           idempotency_key, request_id, request_json, tenant_id, status,
           requested_at, updated_at
         ) VALUES (?, ?, ?, ?, 'requested', ?, ?)`,
        request.idempotencyKey,
        request.requestId,
        requestJson,
        request.tenantId,
        request.requestedAt,
        updatedAt,
      );
      this.insertEffectInTransaction(
        validatePlatformEffectIntent({
          schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
          intentId: `effect:memory-deletion:${request.idempotencyKey}`,
          idempotencyKey: `memory-deletion:${request.idempotencyKey}`,
          scope: "tenant",
          tenantId: request.tenantId,
          kind: "memory_deletion",
          targetRef: `memory-deletion:${request.idempotencyKey}`,
          metadata: {
            deletionEpoch: request.deletionEpoch,
            requestId: request.requestId,
          },
          requestedAt: request.requestedAt,
        }),
        updatedAt,
      );
      return { ok: true, duplicate: false, status: "requested", request };
    });
  }

  getMemoryDeletion(value: unknown): MemoryDeletionRequest & { status: string } {
    const key = id(value, "idempotency_key");
    const row = this.sql.exec<DeletionRow>(
      `SELECT * FROM memory_deletion_requests WHERE idempotency_key = ?`,
      key,
    ).toArray()[0];
    if (!row) throw new PlatformStateError("memory_deletion_not_found", 404);
    return { ...parseJson<MemoryDeletionRequest>(row.request_json), status: row.status };
  }

  private effectById(intentId: string): PlatformEffectRow | undefined {
    return this.sql.exec<PlatformEffectRow>(
      `SELECT * FROM platform_effect_intents WHERE intent_id = ?`,
      intentId,
    ).toArray()[0];
  }

  private assertEffectLease(row: PlatformEffectRow, leaseToken: string): void {
    if (row.status !== "leased" || row.lease_token !== leaseToken) {
      throw new PlatformStateError("effect_lease_mismatch", 409);
    }
    const now = nowIso(this.now);
    if (!row.lease_expires_at || row.lease_expires_at <= now) {
      throw new PlatformStateError("effect_lease_expired", 409);
    }
  }

  private provisioningByKey(key: string): ProvisioningRow | undefined {
    return this.sql.exec<ProvisioningRow>(
      `SELECT * FROM provisioning WHERE idempotency_key = ?`,
      key,
    ).toArray()[0];
  }

  private provisioningByTenant(tenantId: string): ProvisioningRow | undefined {
    return this.sql.exec<ProvisioningRow>(
      `SELECT * FROM provisioning WHERE tenant_id = ?`,
      tenantId,
    ).toArray()[0];
  }

  private insertMarketplaceEffect(
    entry: ConnectorMarketplaceEntry,
    requestedAt: string,
    operation: "curate" | "deprecate" | "revoke",
  ): void {
    this.insertEffectInTransaction(
      validatePlatformEffectIntent({
        schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
        intentId: `effect:marketplace:${entry.connectorId}:${entry.version}:${operation}`,
        idempotencyKey: `marketplace:${entry.connectorId}:${entry.version}:${operation}`,
        scope: "platform",
        kind: "marketplace",
        targetRef: `${entry.connectorId}:${entry.version}`,
        metadata: {
          authMode: entry.authMode,
          connectorId: entry.connectorId,
          operation,
          provider: entry.provider,
          status: entry.status,
          trustReviewRef: entry.trustReviewRef,
          version: entry.version,
        },
        requestedAt,
      }),
      requestedAt,
    );
  }

  private insertOAuthRevokeEffect(
    grant: ConnectorOAuthGrant,
    requestedAt: string,
    operation: "credential_revocation" | "credential_rotation" | "explicit_revoke" | "grant_rotation" | "marketplace_revocation",
  ): void {
    this.insertEffectInTransaction(
      validatePlatformEffectIntent({
        schemaVersion: PLATFORM_STATE_SCHEMA_VERSION,
        intentId: `effect:oauth-revoke:${grant.tenantId}:${grant.principalId}:${grant.connectorId}:${grant.version}`,
        idempotencyKey: `oauth-revoke:${grant.tenantId}:${grant.principalId}:${grant.connectorId}:${grant.version}`,
        scope: "tenant",
        tenantId: grant.tenantId,
        kind: "connector_oauth",
        targetRef: grant.connectorId,
        metadata: {
          connectorId: grant.connectorId,
          credentialRef: grant.credentialRef,
          operation,
          principalId: grant.principalId,
          marketplaceVersion: grant.marketplaceVersion,
          version: grant.version,
        },
        requestedAt,
      }),
      requestedAt,
    );
  }

  private revokeOAuthGrantsForCredential(
    credentialRef: string,
    revokedAt: string,
    operation: "credential_revocation" | "credential_rotation",
  ): void {
    const rows = this.sql.exec<OAuthRow>(
      `SELECT * FROM connector_oauth_grants WHERE credential_ref = ? AND status != 'revoked'`,
      credentialRef,
    ).toArray();
    for (const row of rows) {
      const grant = parseJson<ConnectorOAuthGrant>(row.grant_json);
      this.sql.exec(
        `UPDATE connector_oauth_grants
         SET grant_json = ?, status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
        json({ ...grant, status: "revoked" as const, revokedAt }),
        revokedAt,
        revokedAt,
        row.tenant_id,
        row.principal_id,
        row.connector_id,
      );
      this.insertOAuthRevokeEffect(grant, revokedAt, operation);
    }
  }

  private revokeOAuthGrantsForMarketplace(
    connectorId: string,
    marketplaceVersion: string,
    revokedAt: string,
  ): void {
    const rows = this.sql.exec<OAuthRow>(
      `SELECT * FROM connector_oauth_grants WHERE connector_id = ? AND status != 'revoked'`,
      connectorId,
    ).toArray();
    for (const row of rows) {
      const grant = parseJson<ConnectorOAuthGrant>(row.grant_json);
      if (grant.marketplaceVersion !== marketplaceVersion) continue;
      this.sql.exec(
        `UPDATE connector_oauth_grants
         SET grant_json = ?, status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND connector_id = ?`,
        json({ ...grant, status: "revoked" as const, revokedAt }),
        revokedAt,
        revokedAt,
        row.tenant_id,
        row.principal_id,
        row.connector_id,
      );
      this.insertOAuthRevokeEffect(grant, revokedAt, "marketplace_revocation");
    }
  }
}

type IdentityRow = {
  identity_ref: string;
  tenant_id: string;
  backend: IdentityCustodyReference["backend"];
  public_key: string;
  version: number;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at: string | null;
  updated_at: string;
};

function identityFromRow(row: IdentityRow): IdentityCustodyReference {
  return validateIdentityCustodyReference({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    identityRef: row.identity_ref,
    backend: row.backend,
    publicKey: row.public_key,
    version: row.version,
    status: row.status,
    issuedAt: row.issued_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
}

type CredentialRow = {
  credential_ref: string;
  tenant_id: string;
  backend: CredentialCustodyReference["backend"];
  provider: string;
  subject: string;
  scopes_json: string;
  version: number;
  status: "active" | "revoked";
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  updated_at: string;
};

function credentialFromRow(row: CredentialRow): CredentialCustodyReference {
  return validateCredentialCustodyReference({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    credentialRef: row.credential_ref,
    backend: row.backend,
    provider: row.provider,
    subject: row.subject,
    scopes: parseJson<string[]>(row.scopes_json),
    version: row.version,
    status: row.status,
    issuedAt: row.issued_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
}

type MarketplaceRow = {
  connector_id: string;
  version: string;
  entry_json: string;
  status: ConnectorMarketplaceEntry["status"];
  updated_at: string;
};

function marketplaceFromRow(row: MarketplaceRow): ConnectorMarketplaceEntry {
  const entry = parseJson<Record<string, unknown>>(row.entry_json);
  return validateConnectorMarketplaceEntry({ ...entry, status: row.status });
}

type OAuthRow = {
  tenant_id: string;
  principal_id: string;
  connector_id: string;
  grant_json: string;
  credential_ref: string;
  version: number;
  status: ConnectorOAuthGrant["status"];
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  updated_at: string;
};

function oauthKey(value: unknown): { tenantId: string; principalId: string; connectorId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformStateError("oauth_lookup_invalid", 400);
  }
  const input = value as Record<string, unknown>;
  return {
    tenantId: id(input.tenantId, "tenant_id"),
    principalId: id(input.principalId, "principal_id"),
    connectorId: id(input.connectorId, "connector_id"),
  };
}

type MeterRow = {
  idempotency_key: string;
  event_id: string;
  event_json: string;
  tenant_id: string;
  execution_id: string;
  tier: number;
  metric: string;
  quantity: number;
  unit: string;
  plan_revision: number;
  occurred_at: string;
  recorded_at: string;
};

type MemoryPolicyRow = {
  tenant_id: string;
  policy_json: string;
  deletion_epoch: number;
  updated_at: string;
};

type DeletionRow = {
  idempotency_key: string;
  request_id: string;
  request_json: string;
  tenant_id: string;
  status: string;
  requested_at: string;
  updated_at: string;
};

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PlatformStateError("invalid_json", 400);
  }
}

function responseForError(error: unknown): Response {
  if (error instanceof PlatformFoundationError || error instanceof PlatformStateError) {
    const status = error instanceof PlatformStateError ? error.status : 400;
    return Response.json({ error: error.code }, { status });
  }
  console.error("[platform-state] request failed", error instanceof Error ? error.message : "unknown");
  return Response.json({ error: "platform_state_internal_error" }, { status: 503 });
}

export class PlatformStateDO extends DurableObject {
  private readonly engine: PlatformStateEngine;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;
    void this.ctx.blockConcurrencyWhile(async () => {
      migratePlatformState(sql);
    });
    this.engine = new PlatformStateEngine({
      sql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    });
  }

  async healthCheck(): Promise<{ ok: true; storage: "sqlite" }> {
    this.ctx.storage.sql.exec(`SELECT 1 AS ok`).one();
    return { ok: true, storage: "sqlite" };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json(await this.healthCheck());
      }
      if (url.pathname === "/effect/enqueue" && request.method === "POST") {
        return Response.json(this.engine.enqueueEffect(await readJson(request)));
      }
      if (url.pathname === "/effect/get" && request.method === "POST") {
        return Response.json(this.engine.getEffect(await readJson(request)));
      }
      if (url.pathname === "/effect/list" && request.method === "POST") {
        return Response.json(this.engine.listEffects(await readJson(request)));
      }
      if (url.pathname === "/effect/claim" && request.method === "POST") {
        return Response.json(this.engine.claimEffect(await readJson(request)));
      }
      if (url.pathname === "/effect/complete" && request.method === "POST") {
        return Response.json(this.engine.completeEffect(await readJson(request)));
      }
      if (url.pathname === "/effect/fail" && request.method === "POST") {
        return Response.json(this.engine.failEffect(await readJson(request)));
      }
      if (url.pathname === "/effect/cancel" && request.method === "POST") {
        return Response.json(this.engine.cancelEffect(await readJson(request)));
      }
      if (url.pathname === "/provision" && request.method === "POST") {
        return Response.json(await this.engine.provision(await readJson(request)));
      }
      if (url.pathname === "/provision/step" && request.method === "POST") {
        return Response.json(this.engine.advanceProvisioning(await readJson(request)));
      }
      if (url.pathname === "/provision/get" && request.method === "POST") {
        return Response.json(this.engine.getProvisioning(await readJson(request)));
      }
      if (url.pathname === "/identity" && request.method === "POST") {
        return Response.json(this.engine.putIdentity(await readJson(request)));
      }
      if (url.pathname === "/identity/get" && request.method === "POST") {
        return Response.json(this.engine.getIdentity((await readJson(request))));
      }
      if (url.pathname === "/identity/revoke" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(this.engine.revokeIdentity(
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).identityRef
            : body,
        ));
      }
      if (url.pathname === "/credential" && request.method === "POST") {
        return Response.json(this.engine.putCredential(await readJson(request)));
      }
      if (url.pathname === "/credential/get" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(this.engine.getCredential(
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).credentialRef
            : body,
        ));
      }
      if (url.pathname === "/credential/revoke" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(this.engine.revokeCredential(
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).credentialRef
            : body,
        ));
      }
      if (url.pathname === "/marketplace" && request.method === "POST") {
        return Response.json(this.engine.putMarketplace(await readJson(request)));
      }
      if (url.pathname === "/marketplace/list" && request.method === "POST") {
        return Response.json(this.engine.listMarketplace(await readJson(request)));
      }
      if (url.pathname === "/marketplace/revoke" && request.method === "POST") {
        return Response.json(this.engine.revokeMarketplace(await readJson(request)));
      }
      if (url.pathname === "/oauth" && request.method === "POST") {
        return Response.json(this.engine.putOAuthGrant(await readJson(request)));
      }
      if (url.pathname === "/oauth/get" && request.method === "POST") {
        return Response.json(this.engine.getOAuthGrant(await readJson(request)));
      }
      if (url.pathname === "/oauth/revoke" && request.method === "POST") {
        return Response.json(this.engine.revokeOAuthGrant(await readJson(request)));
      }
      if (url.pathname === "/meter" && request.method === "POST") {
        return Response.json(this.engine.recordMeter(await readJson(request)));
      }
      if (url.pathname === "/meter/list" && request.method === "POST") {
        return Response.json(this.engine.listMeter(await readJson(request)));
      }
      if (url.pathname === "/memory/policy" && request.method === "POST") {
        return Response.json(this.engine.putMemoryPolicy(await readJson(request)));
      }
      if (url.pathname === "/memory/policy/get" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(this.engine.getMemoryPolicy(
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).tenantId
            : body,
        ));
      }
      if (url.pathname === "/memory/deletion" && request.method === "POST") {
        return Response.json(this.engine.requestMemoryDeletion(await readJson(request)));
      }
      if (url.pathname === "/memory/deletion/get" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(this.engine.getMemoryDeletion(
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).idempotencyKey
            : body,
        ));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return responseForError(error);
    }
  }
}
