/**
 * OpenTag edge Worker — Claude Tag bot spine (PRODUCT.md).
 * Slack ingress → CloudflareSlackAdapter → createBot (Channels).
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "./env.js";
import { createDurableObjectStore } from "./store/index.js";
import { slackVerify } from "./slack-verify.js";
import { requireAdminAuth } from "./admin-auth.js";
import {
  getOrCreateBot,
  resolveBotEngineKind,
} from "./bot-engine.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "./config/workspace-config-do.js";
import { startTask } from "./tasks/runtime.js";
import {
  extractStopCommandEvent,
  handleStopCommand,
  type SlackEventCallbackPayload,
} from "./slack/stop-routing.js";
import {
  handleQuickAction,
  isQuickInteraction,
  quickActionEventId,
} from "./slack/quick-actions.js";
import {
  abandonPreAdmittedTurn,
  preAdmissionIdentityForCommand,
  preAdmissionIdentityForEvent,
  preAdmitSlackTurnResult,
} from "./slack/pre-admit-turn.js";
import { postTurnRejectedFeedback } from "./slack/turn-lifecycle.js";
import { createBotStoreAdapter } from "./create-bot-store.js";
import { verifySessionViewToken } from "./slack/session-link.js";
import { probeDurabilityHealth } from "./health.js";
import { buildRuntimeCapabilityEvidence } from "./runtime-evidence.js";
import { handleKnowledgeMcp } from "./mcp/knowledge-mcp.js";
import {
  hydrateLateFileRefs,
  lateFileRepairDedupeKey,
  consumedLateFileKey,
  pendingLateFileScopeKey,
  selectPendingLateFileMention,
  waitForLateFileThreadIdle,
  LATE_FILE_WINDOW_MS,
  type LateFileEvent,
  type PendingFilelessMention,
} from "./slack/late-file-repair.js";
import { createSlackWebClient, sharedSlackRateScheduler } from "./slack/web-api.js";
import { slackObligationThreadKey } from "./slack/obligation-thread-key.js";
import { assertTenantId, tenantStub } from "./tenancy.js";
import type { DeferredIngressJob } from "./deferred-ingress-do.js";
import { loadTurnAccess, resolveAllowedTools } from "./config/workspace-config-do.js";
import { ALL_EDGE_TOOL_NAMES } from "./tools/index.js";
import { buildPermissionSnapshot } from "./permissions/snapshot.js";
import {
  parseTrustedTriggerConfig,
  trustedTriggerReadiness,
  trustedRichTriggerDecision,
} from "./slack/trusted-trigger.js";
import {
  handleKnowledgeQueue,
  scheduleKnowledgeFromSlackEvent,
} from "./memory/knowledge-jobs.js";
import {
  handleKnowledgeDlq,
  inspectDurableKnowledgeDlq,
  replayDurableKnowledgeDlqRecord,
  runKnowledgeReconciliationPage,
  runScheduledKnowledgeReconciliation,
} from "./memory/knowledge-reconcile.js";
import {
  approveKnowledgeBackfillManifest,
  discoverAndStoreKnowledgeBackfill,
  executeKnowledgeBackfillPage,
} from "./memory/knowledge-backfill.js";
import {
  KNOWLEDGE_BACKFILL_APPROVAL_HEADER,
  KnowledgeBackfillApprovalError,
} from "./memory/knowledge-backfill-authorization.js";
import { dispatchKnowledgeToSupermemory } from "./memory/supermemory-adapter.js";
import { revokeKnowledgeActor } from "./memory/knowledge-do.js";
import type { KnowledgeJob } from "./memory/knowledge-contract.js";
import {
  retryKnowledgeBatchWithoutParsing,
  routeKnowledgeQueueName,
} from "./memory/knowledge-queue-routing.js";
import {
  KNOWLEDGE_SOURCE_GRANT_HEADER,
  KnowledgeSourceAuthorizationError,
  parseKnowledgeSourceAdminRequest,
  verifyKnowledgeSourceGrant,
  type KnowledgeSourceAction,
} from "./config/knowledge-source-authorization.js";
import { BuzzContractError } from "./buzz/contract.js";
import { tryBuildBuzzWakeReceiveDeps } from "./buzz/wake-bindings.js";
import {
  handleBuzzWakeHttp,
  readBuzzWakeJsonBody,
} from "./buzz/wake-http.js";
import {
  deriveInternalTenantId,
  PLATFORM_MARKETPLACE_OBJECT_NAME,
  platformTenantObjectName,
} from "./platform/platform-state-do.js";
import {
  OAUTH_STATE_OBJECT_NAME,
} from "./platform/oauth-state-do.js";
import {
  assertConnectorMarketplaceEntryActivatable,
  PlatformFoundationError,
  validateConnectorMarketplaceEntry,
  validateProvisioningRequest,
} from "./platform/layer3-contract.js";
import { TENANT_LOCATOR_SCHEMA_VERSION } from "./platform/tenant-locator.js";
import {
  enqueuePlatformEffectWakeup,
  handlePlatformEffectQueue,
  isPlatformEffectQueueName,
  type PlatformEffectWakeup,
} from "./platform/effect-dispatch.js";
import type { MessageBatch } from "@cloudflare/workers-types";

export { ConversationStateDO } from "./store/index.js";
export { WorkspaceConfigDO } from "./config/workspace-config-do.js";
export { KnowledgeDO } from "./memory/knowledge-do.js";
export { SessionEventDO } from "./store/session-event-do.js";
export { DeferredIngressDO } from "./deferred-ingress-do.js";
export { SlackRateLimitDO } from "./slack/slack-rate-limit-do.js";
export { PlatformStateDO } from "./platform/platform-state-do.js";
export { RouterMeasurementDO } from "./router/measurement-do.js";
export { OAuthStateDO } from "./platform/oauth-state-do.js";

const app = new Hono<AppEnv>();

function adminForwardStatus(status: number): 400 | 404 | 409 | 503 {
  if (status >= 500) return 503;
  if (status === 409) return 409;
  if (status === 404) return 404;
  return 400;
}

function deferredIngressStub(env: AppEnv["Bindings"], jobId: string) {
  if (!env.DEFERRED_INGRESS) {
    throw new Error("DEFERRED_INGRESS is required for durable Slack ingress");
  }
  return env.DEFERRED_INGRESS.get(
    env.DEFERRED_INGRESS.idFromName(jobId),
  ) as unknown as {
    prepare(job: DeferredIngressJob): Promise<{
      accepted: boolean;
      status: "pending" | "running" | "completed" | "exhausted";
    }>;
  };
}

type LateFileRepairJobPayload = {
  callback: SlackEventCallbackPayload;
  pending: PendingFilelessMention;
  candidate: LateFileEvent;
};

type FileTurnJobPayload = {
  callback: SlackEventCallbackPayload;
};

function fileTurnJobId(
  env: AppEnv["Bindings"],
  callback: SlackEventCallbackPayload,
): string | undefined {
  const identity = preAdmissionIdentityForEvent(
    callback,
    parseTrustedTriggerConfig(
      env.SLACK_BOT_USER_ID,
      env.SLACK_TRUSTED_TRIGGER_ACTORS,
    ),
  );
  return identity ? `file-turn:${identity.eventId}` : undefined;
}

async function processFileTurn(
  env: AppEnv["Bindings"],
  value: FileTurnJobPayload,
  teamId: string,
): Promise<void> {
  const identity = preAdmissionIdentityForEvent(
    value.callback,
    parseTrustedTriggerConfig(
      env.SLACK_BOT_USER_ID,
      env.SLACK_TRUSTED_TRIGGER_ACTORS,
    ),
  );
  if (!identity) throw new Error("file_turn_identity_unavailable");
  const admission = await preAdmitSlackTurnResult(env, identity);
  if (admission.status === "duplicate") return;
  if (admission.status === "concurrent") {
    throw new Error("file_turn_concurrent_active_turn");
  }
  if (admission.status === "ineligible") {
    throw new Error("file_turn_identity_unavailable");
  }
  const preAdmittedTurn = admission.turn;
  let handedOff = false;
  try {
    const { adapter } = await getOrCreateBot(env);
    await adapter.handleEventsBody(value.callback, {
      teamId,
      preAdmittedTurn,
      onTurnHandoff: () => { handedOff = true; },
    });
    if (!handedOff) throw new Error("file_turn_not_handed_off");
  } finally {
    if (!handedOff) await abandonPreAdmittedTurn(env, preAdmittedTurn);
  }
}

async function processLateFileRepair(
  env: AppEnv["Bindings"],
  value: LateFileRepairJobPayload,
): Promise<void> {
  const { callback, pending, candidate } = value;
  const store = createDurableObjectStore(env.BOT_STATE);
  const token = env.SLACK_BOT_TOKEN;
  const files = token
    ? await hydrateLateFileRefs(candidate.files, async (fileId) =>
        createSlackWebClient(token, {
          scheduler: sharedSlackRateScheduler(
            env.ENVIRONMENT,
            env.SLACK_RATE_LIMIT,
          ),
        }).getFileInfo(fileId))
    : candidate.files;
  const idle = await waitForLateFileThreadIdle(async () => {
    const active = await store.activeTurn.get(
      slackObligationThreadKey(candidate.teamId, candidate.channelId, pending.threadTs),
    );
    return Boolean(active);
  });
  if (!idle) throw new Error("late_file_repair_thread_busy");
  const synthetic = {
    ...callback,
    event_id: lateFileRepairDedupeKey(pending, { ...candidate, files }),
    event: {
      ...(callback.event as Record<string, unknown> | undefined),
      // This is a synthetic continuation of the already admitted mention that
      // arrived before Slack exposed its file metadata. Keep the file-share
      // subtype so the internal repair path does not become a new text turn.
      type: "message",
      subtype: "file_share",
      channel: candidate.channelId,
      thread_ts: pending.threadTs,
      text: "Use the newly attached file(s) with my previous request.",
      files,
    },
  } as SlackEventCallbackPayload;
  const identity = preAdmissionIdentityForEvent(
    synthetic,
    parseTrustedTriggerConfig(
      env.SLACK_BOT_USER_ID,
      env.SLACK_TRUSTED_TRIGGER_ACTORS,
    ),
  );
  const markConsumed = () => store.kv.set(
    consumedLateFileKey(pending),
    true,
    Math.max(1, pending.expiresAt - Date.now()),
  );
  const admission = await preAdmitSlackTurnResult(env, identity);
  if (admission.status === "duplicate") {
    await markConsumed();
    return;
  }
  if (admission.status === "concurrent") {
    throw new Error("late_file_repair_concurrent_active_turn");
  }
  if (admission.status === "ineligible") {
    throw new Error("late_file_repair_identity_unavailable");
  }
  const preAdmittedTurn = admission.turn;
  let handedOff = false;
  try {
    const { adapter } = await getOrCreateBot(env);
    await adapter.handleEventsBody(synthetic, {
      teamId: candidate.teamId,
      preAdmittedTurn,
      onTurnHandoff: () => { handedOff = true; },
    });
    if (!handedOff) throw new Error("late_file_repair_not_handed_off");
    await markConsumed();
  } finally {
    if (!handedOff) await abandonPreAdmittedTurn(env, preAdmittedTurn);
  }
}

app.post("/internal/deferred-ingress", requireAdminAuth(), async (c) => {
  const job = await c.req.json<DeferredIngressJob>();
  try {
    if (job.kind === "quick_action") {
      if (quickActionEventId(job.payload) !== job.id) {
        return c.json({ error: "deferred_ingress_identity_mismatch" }, 400);
      }
      const result = await handleQuickAction(c.env, job.payload, job.teamId);
      if (!result.handled) {
        return c.json({ error: "invalid_quick_action" }, 400);
      }
    } else if (job.kind === "late_file") {
      const payload = job.payload as LateFileRepairJobPayload;
      if (lateFileRepairDedupeKey(payload.pending, payload.candidate) !== job.id) {
        return c.json({ error: "deferred_ingress_identity_mismatch" }, 400);
      }
      await processLateFileRepair(c.env, payload);
    } else if (job.kind === "file_turn") {
      const payload = job.payload as FileTurnJobPayload;
      if (fileTurnJobId(c.env, payload.callback) !== job.id) {
        return c.json({ error: "deferred_ingress_identity_mismatch" }, 400);
      }
      await processFileTurn(c.env, payload, job.teamId);
    } else {
      return c.json({ error: "unsupported_deferred_ingress_kind" }, 400);
    }
    return c.json({ ok: true });
  } catch (error) {
    console.error("[internal/deferred-ingress]", error);
    return c.json({ error: "deferred_ingress_processing_failed" }, 503);
  }
});

app.get("/sessions/:token", async (c) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || !c.env.SESSION_EVENTS) {
    return c.json({ error: "session_view_unavailable" }, 503);
  }
  const claims = await verifySessionViewToken(c.req.param("token"), secret);
  if (!claims) return c.json({ error: "invalid_or_expired_session_link" }, 401);
  const session = c.env.SESSION_EVENTS.get(
    c.env.SESSION_EVENTS.idFromName(claims.threadKey),
  ) as unknown as {
    getState(): Promise<unknown>;
    replay(afterEventId?: number): Promise<unknown[]>;
  };
  const [state, events] = await Promise.all([session.getState(), session.replay()]);
  return c.json({ threadKey: claims.threadKey, state, events }, 200, {
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex, nofollow",
  });
});

app.get("/health", async (c) => {
  const durability = await probeDurabilityHealth(c.env);
  const trustedRichMention = trustedTriggerReadiness(
    parseTrustedTriggerConfig(
      c.env.SLACK_BOT_USER_ID,
      c.env.SLACK_TRUSTED_TRIGGER_ACTORS,
    ),
  );
  const ok = durability.ok && trustedRichMention.ok;
  return c.json({
    ok,
    product: "claude-tag-cf",
    store: "durable-object-sqlite",
    spine: ["BOT_STATE", "SESSION_EVENTS", "WORKSPACE_CONFIG", "KNOWLEDGE", "PLATFORM_STATE", "RESEARCH_TASKS"],
    checks: durability.checks,
    runtime: buildRuntimeCapabilityEvidence(c.env),
    trustedRichMention,
    botEngine: await resolveBotEngineKind(),
  }, ok ? 200 : 503);
});

/**
 * Buzz wake ingress. Binds NIP-98 fetcher + runtime-admit only when the
 * Cloudflare-secret signer seam, relay base URL, distinct allowed-origin
 * grant, and channel→tenant map are all present; otherwise fails closed with
 * 503 (no dedupe / fetch / admit).
 */
app.post("/buzz/wake", async (c) => {
  let deps;
  try {
    const configured =
      Boolean(c.env.BUZZ_OPEN_TAG_SIGNER_SECRET)
      && Boolean(c.env.BUZZ_RELAY_HTTP_BASE_URL)
      && Boolean(c.env.BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN)
      && Boolean(c.env.BUZZ_CHANNEL_TENANT_MAP)
      && Boolean(c.env.BOT_STATE);
    const store = configured
      ? createDurableObjectStore(c.env.BOT_STATE)
      : undefined;
    deps = tryBuildBuzzWakeReceiveDeps(c.env, store);
  } catch (error) {
    if (error instanceof BuzzContractError) {
      return new Response(
        JSON.stringify({ status: "error", error: error.code }),
        { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    if (error instanceof Error && error.message === "buzz_signer_invalid_secret_shape") {
      return new Response(
        JSON.stringify({ status: "error", error: "buzz_signer_invalid_secret_shape" }),
        { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    // Mis-set optional auth-tag must not degrade into a live fetch → relay 403.
    if (error instanceof Error && error.message === "buzz_auth_tag_invalid_shape") {
      return new Response(
        JSON.stringify({ status: "error", error: "buzz_auth_tag_invalid_shape" }),
        { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    return new Response(
      JSON.stringify({ status: "error", error: "buzz_receive_not_configured" }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  if (deps === undefined) {
    return handleBuzzWakeHttp(null, undefined);
  }
  try {
    const raw = await readBuzzWakeJsonBody(c.req.raw);
    return handleBuzzWakeHttp(raw, deps);
  } catch (error) {
    if (error instanceof BuzzContractError) {
      return new Response(
        JSON.stringify({ status: "error", error: error.code }),
        { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    return new Response(
      JSON.stringify({ status: "error", error: "buzz_receive_internal_error" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
});

app.get("/debug/store", requireAdminAuth(), async (c) => {
  const store = createDurableObjectStore(c.env.BOT_STATE);
  const k = `debug:${crypto.randomUUID()}`;
  await store.kv.set(k, { hello: "edge" }, 5_000);
  const got = await store.kv.get<{ hello: string }>(k);
  await store.list.append(k, "a");
  const list = await store.list.range<string>(k);
  const lock = await store.lock.acquire(`${k}:lock`, { ttlMs: 1_000 });
  if (lock) await store.lock.release(`${k}:lock`, lock.token);
  const firstSeen = await store.dedup.seen(`${k}:evt`, 5_000);
  const secondSeen = await store.dedup.seen(`${k}:evt`, 5_000);
  const hasAfterSeen = await store.dedup.has(`${k}:evt`);
  const hasUnseen = await store.dedup.has(`${k}:never`);
  return c.json({
    kv: got,
    list,
    lock: { acquired: lock !== null },
    dedup: { firstSeen, secondSeen, hasAfterSeen, hasUnseen },
  });
});

app.post("/admin/config", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as WorkspaceChannelConfig & {
    expectedRevision?: number;
    systemPromptOverlay?: {
      version?: number;
      revision?: number;
      text?: string;
      digest?: string;
      source?: string;
    };
  };
  const stub = tenantStub(c.env.WORKSPACE_CONFIG, body.teamId);

  const hasChannelContext =
    body.channelContext !== undefined || body.systemPrompt !== undefined;
  const hasRuntimeDefaults = "runtimeDefaults" in body;
  const hasAccessBundle =
    typeof body.accessBundleId === "string" && body.accessBundleId.length > 0;
  const hasAdminOwnedFields =
    body.systemPromptOverlay !== undefined ||
    body.policies !== undefined ||
    hasAccessBundle;

  let runtimeDefaults: ReturnType<typeof normalizeChannelRuntimeDefaults>;
  if (hasRuntimeDefaults) {
    try {
      runtimeDefaults = normalizeChannelRuntimeDefaults(body.runtimeDefaults);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "invalid runtime defaults" },
        400,
      );
    }
  }

  // Single DO write when admin-owned fields are present so overlay CAS, channel
  // context, and runtime defaults cannot partially apply across two RPCs.
  if (hasAdminOwnedFields) {
    const response = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId: body.teamId,
        channelId: body.channelId,
        ...(hasChannelContext
          ? { channelContext: body.channelContext ?? body.systemPrompt }
          : {}),
        systemPromptOverlay: body.systemPromptOverlay,
        policies: body.policies,
        ...(hasAccessBundle ? { accessBundleId: body.accessBundleId } : {}),
        ...(hasRuntimeDefaults ? { runtimeDefaults: runtimeDefaults ?? null } : {}),
        ...(body.systemPromptOverlay !== undefined
          ? { expectedRevision: body.expectedRevision }
          : {}),
        updatedAt: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      return c.json(
        { error: await response.text() },
        response.status >= 500 ? 503 : response.status === 409 ? 409 : 400,
      );
    }
    return c.json(await response.json());
  }

  if (hasChannelContext || hasRuntimeDefaults) {
    const channelResponse = await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId: body.teamId,
        channelId: body.channelId,
        ...(hasChannelContext
          ? { channelContext: body.channelContext ?? body.systemPrompt }
          : {}),
        ...(hasRuntimeDefaults ? { runtimeDefaults: runtimeDefaults ?? null } : {}),
        updatedAt: new Date().toISOString(),
      }),
    });
    if (!channelResponse.ok) {
      return c.json(
        { error: await channelResponse.text() },
        channelResponse.status >= 500 ? 503 : 400,
      );
    }
  }

  return c.json({ ok: true });
});

app.post("/admin/bundle", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as AccessBundle & { teamId: string };
  const stub = tenantStub(c.env.WORKSPACE_CONFIG, body.teamId);
  const response = await stub.fetch("https://do/putBundle", {
    method: "POST",
    body: JSON.stringify({
      id: body.id,
      tools: body.tools ?? [],
      mcpEndpoints: body.mcpEndpoints ?? [],
      secretRefs: body.secretRefs ?? [],
      ...(body.connectorGrants !== undefined ? { connectorGrants: body.connectorGrants } : {}),
    } satisfies AccessBundle),
  });
  if (!response.ok) {
    return c.json(
      { error: await response.text() },
      adminForwardStatus(response.status),
    );
  }
  return c.json(await response.json());
});

app.post("/admin/bundle/revoke", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as { teamId?: unknown; id?: unknown };
  if (typeof body.teamId !== "string" || typeof body.id !== "string") {
    return c.json({ error: "teamId_and_bundle_id_required" }, 400);
  }
  const stub = tenantStub(c.env.WORKSPACE_CONFIG, body.teamId);
  const response = await stub.fetch("https://do/revokeBundle", {
    method: "POST",
    body: JSON.stringify({ id: body.id }),
  });
  if (!response.ok) {
    return c.json(
      { error: await response.text() },
      adminForwardStatus(response.status),
    );
  }
  return c.json(await response.json());
});

app.post("/admin/connector-credential", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as { teamId?: unknown } & Record<string, unknown>;
  if (typeof body.teamId !== "string") return c.json({ error: "teamId_required" }, 400);
  const { teamId, ...reference } = body;
  const stub = tenantStub(c.env.WORKSPACE_CONFIG, teamId);
  const response = await stub.fetch("https://do/putConnectorCredentialReference", {
    method: "POST",
    body: JSON.stringify(reference),
  });
  if (!response.ok) {
    return c.json(
      { error: await response.text() },
      adminForwardStatus(response.status),
    );
  }
  return c.json(await response.json());
});

app.post("/admin/connector-credential/revoke", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as { teamId?: unknown; ref?: unknown };
  if (typeof body.teamId !== "string" || typeof body.ref !== "string") {
    return c.json({ error: "teamId_and_credential_ref_required" }, 400);
  }
  const stub = tenantStub(c.env.WORKSPACE_CONFIG, body.teamId);
  const response = await stub.fetch("https://do/revokeConnectorCredentialReference", {
    method: "POST",
    body: JSON.stringify({ ref: body.ref }),
  });
  if (!response.ok) {
    return c.json(
      { error: await response.text() },
      adminForwardStatus(response.status),
    );
  }
  return c.json(await response.json());
});

function platformStateStub(
  env: AppEnv["Bindings"],
  objectName: string,
): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | undefined {
  if (!env.PLATFORM_STATE) return undefined;
  return env.PLATFORM_STATE.get(
    env.PLATFORM_STATE.idFromName(objectName),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

function oauthStateStub(
  env: AppEnv["Bindings"],
): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | undefined {
  if (!env.OAUTH_STATE) return undefined;
  return env.OAUTH_STATE.get(
    env.OAUTH_STATE.idFromName(OAUTH_STATE_OBJECT_NAME),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

async function forwardOAuthState(
  c: Context<AppEnv>,
  path: "/issue" | "/consume",
  body: unknown,
): Promise<Response> {
  const stub = oauthStateStub(c.env);
  if (!stub) return c.json({ error: "oauth_state_unavailable" }, 503);
  const response = await stub.fetch(`https://oauth-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return new Response(text, {
    status: response.ok ? 200 : adminForwardStatus(response.status),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function forwardPlatformState(
  c: Context<AppEnv>,
  objectName: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const stub = platformStateStub(c.env, objectName);
  if (!stub) return c.json({ error: "platform_state_unavailable" }, 503);
  const response = await stub.fetch(`https://platform-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.ok && PLATFORM_EFFECT_MUTATION_PATHS.has(path)) {
    if (c.env.PLATFORM_EFFECTS_QUEUE) {
      c.executionCtx.waitUntil(
        enqueuePlatformEffectWakeup(c.env.PLATFORM_EFFECTS_QUEUE, objectName).catch((error) => {
          console.error(JSON.stringify({
            metric: "platform_effect_wakeup_enqueue_failed",
            errorCode: error instanceof Error ? error.message : "unknown",
          }));
        }),
      );
    } else {
      console.error(JSON.stringify({
        metric: "platform_effect_wakeup_queue_unconfigured",
        path,
      }));
    }
  }
  return new Response(text, {
    status: response.ok ? 200 : adminForwardStatus(response.status),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const PLATFORM_EFFECT_MUTATION_PATHS = new Set([
  "/provision",
  "/provision/step",
  "/identity",
  "/identity/revoke",
  "/credential",
  "/credential/revoke",
  "/marketplace",
  "/marketplace/revoke",
  "/oauth",
  "/oauth/revoke",
  "/meter",
  "/memory/deletion",
  "/effect/enqueue",
  "/effect/complete",
  "/effect/fail",
  "/effect/cancel",
]);

function platformEffectObjectName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const input = body as Record<string, unknown>;
  if (input.scope === "platform") return PLATFORM_MARKETPLACE_OBJECT_NAME;
  if (input.scope === "tenant" && typeof input.tenantId === "string") {
    return platformTenantObjectName(input.tenantId);
  }
  return undefined;
}

async function forwardPlatformEffect(
  c: Context<AppEnv>,
  path: string,
  body: unknown,
): Promise<Response> {
  const objectName = platformEffectObjectName(body);
  if (!objectName) return c.json({ error: "effect_scope_and_tenant_required" }, 400);
  return forwardPlatformState(c, objectName, path, body);
}

function routerMeasurementStub(
  env: AppEnv["Bindings"],
  workspaceId: string,
): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | undefined {
  if (!env.ROUTER_MEASUREMENTS) return undefined;
  return env.ROUTER_MEASUREMENTS.get(
    env.ROUTER_MEASUREMENTS.idFromName(workspaceId),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

async function forwardRouterMeasurement(
  c: Context<AppEnv>,
  path: string,
): Promise<Response> {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.workspaceId !== "string" || body.workspaceId.trim() === "") {
    return c.json({ error: "workspace_id_required" }, 400);
  }
  const stub = routerMeasurementStub(c.env, body.workspaceId);
  if (!stub) return c.json({ error: "router_measurements_unavailable" }, 503);
  const response = await stub.fetch(`https://router-measurement${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return new Response(text, {
    status: response.ok ? 200 : adminForwardStatus(response.status),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

app.post("/admin/router/summary", requireAdminAuth(), async (c) =>
  forwardRouterMeasurement(c, "/summary"));

app.post("/admin/router/dispatch/list", requireAdminAuth(), async (c) =>
  forwardRouterMeasurement(c, "/dispatch/list"));

app.post("/admin/router/feedback/list", requireAdminAuth(), async (c) =>
  forwardRouterMeasurement(c, "/feedback/list"));

app.post("/admin/platform/tenant-locator", requireAdminAuth(), async (c) => {
  return forwardPlatformState(
    c,
    PLATFORM_MARKETPLACE_OBJECT_NAME,
    "/tenant-locator",
    await c.req.json(),
  );
});

app.post("/admin/platform/tenant-locator/resolve", requireAdminAuth(), async (c) => {
  return forwardPlatformState(
    c,
    PLATFORM_MARKETPLACE_OBJECT_NAME,
    "/tenant-locator/resolve",
    await c.req.json(),
  );
});

app.post("/admin/platform/tenant-locator/revoke", requireAdminAuth(), async (c) => {
  return forwardPlatformState(
    c,
    PLATFORM_MARKETPLACE_OBJECT_NAME,
    "/tenant-locator/revoke",
    await c.req.json(),
  );
});

app.post("/admin/platform/provision", requireAdminAuth(), async (c) => {
  const body = await c.req.json();
  let request: ReturnType<typeof validateProvisioningRequest>;
  try {
    request = validateProvisioningRequest(body);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "provisioning_request_invalid" }, 400);
  }
  const tenantId = await deriveInternalTenantId(request);
  const locatorResponse = await forwardPlatformState(
    c,
    PLATFORM_MARKETPLACE_OBJECT_NAME,
    "/tenant-locator",
    {
      schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
      platform: request.externalPlatform,
      platformTenantId: request.externalTenantId,
      tenantId,
      version: 1,
      status: "active",
      updatedAt: request.requestedAt,
    },
  );
  if (!locatorResponse.ok) return locatorResponse;
  return forwardPlatformState(c, platformTenantObjectName(tenantId), "/provision", body);
});

app.post("/admin/platform/provision/step", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/provision/step", body);
});

app.post("/admin/platform/provision/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/provision/get", body);
});

app.post("/admin/platform/effect/enqueue", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/enqueue", await c.req.json());
});

app.post("/admin/platform/effect/wake", requireAdminAuth(), async (c) => {
  const body = await c.req.json();
  const objectName = platformEffectObjectName(body);
  if (!objectName) return c.json({ error: "effect_scope_and_tenant_required" }, 400);
  if (!c.env.PLATFORM_EFFECTS_QUEUE) {
    return c.json({ error: "platform_effect_queue_unconfigured" }, 503);
  }
  try {
    await enqueuePlatformEffectWakeup(c.env.PLATFORM_EFFECTS_QUEUE, objectName);
  } catch (error) {
    console.error(JSON.stringify({
      metric: "platform_effect_wakeup_enqueue_failed",
      errorCode: error instanceof Error ? error.message : "unknown",
    }));
    return c.json({ error: "platform_effect_queue_unavailable" }, 503);
  }
  return c.json({ ok: true });
});

app.post("/admin/platform/effect/get", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/get", await c.req.json());
});

app.post("/admin/platform/effect/list", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/list", await c.req.json());
});

app.post("/admin/platform/effect/claim", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/claim", await c.req.json());
});

app.post("/admin/platform/effect/complete", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/complete", await c.req.json());
});

app.post("/admin/platform/effect/fail", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/fail", await c.req.json());
});

app.post("/admin/platform/effect/cancel", requireAdminAuth(), async (c) => {
  return forwardPlatformEffect(c, "/effect/cancel", await c.req.json());
});

app.post("/admin/platform/identity", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/identity", body);
});

app.post("/admin/platform/identity/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/identity/get", body);
});

app.post("/admin/platform/identity/revoke", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/identity/revoke", body);
});

app.post("/admin/platform/credential", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/credential", body);
});

app.post("/admin/platform/credential/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/credential/get", body);
});

app.post("/admin/platform/credential/revoke", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/credential/revoke", body);
});

app.post("/admin/platform/marketplace", requireAdminAuth(), async (c) => {
  return forwardPlatformState(c, PLATFORM_MARKETPLACE_OBJECT_NAME, "/marketplace", await c.req.json());
});

app.post("/admin/platform/marketplace/list", requireAdminAuth(), async (c) => {
  return forwardPlatformState(c, PLATFORM_MARKETPLACE_OBJECT_NAME, "/marketplace/list", await c.req.json());
});

app.post("/admin/platform/marketplace/revoke", requireAdminAuth(), async (c) => {
  return forwardPlatformState(c, PLATFORM_MARKETPLACE_OBJECT_NAME, "/marketplace/revoke", await c.req.json());
});

async function ensureCuratedOAuthMarketplace(
  c: Context<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response | undefined> {
  if (typeof body.connectorId !== "string" || typeof body.marketplaceVersion !== "string") {
    return c.json({ error: "oauth_marketplace_identity_required" }, 400);
  }
  const marketplaceResponse = await forwardPlatformState(
    c,
    PLATFORM_MARKETPLACE_OBJECT_NAME,
    "/marketplace/list",
    { connectorId: body.connectorId, version: body.marketplaceVersion },
  );
  if (!marketplaceResponse.ok) return marketplaceResponse;
  const payload = await marketplaceResponse.json() as {
    entries?: Array<Record<string, unknown>>;
  };
  const entry = payload.entries?.[0];
  if (!entry) return c.json({ error: "oauth_marketplace_not_found" }, 409);
  let marketplaceEntry;
  try {
    marketplaceEntry = assertConnectorMarketplaceEntryActivatable(
      validateConnectorMarketplaceEntry(entry),
    );
  } catch (error) {
    if (error instanceof PlatformFoundationError) {
      return c.json({ error: error.code }, 409);
    }
    throw error;
  }
  if (marketplaceEntry.status !== "curated") return c.json({ error: "oauth_marketplace_not_curated" }, 409);
  if (marketplaceEntry.authMode !== "oauth2") return c.json({ error: "oauth_connector_not_oauth2" }, 409);
  if (Array.isArray(body.scopes)) {
    const allowedScopes = [...marketplaceEntry.oauthScopes];
    const requestedScopes = body.scopes.filter((scope): scope is string => typeof scope === "string");
    if (
      requestedScopes.length === 0 ||
      requestedScopes.some((scope) => !allowedScopes.includes(scope))
    ) {
      return c.json({ error: "oauth_scope_not_allowed" }, 409);
    }
  }
  return undefined;
}

/**
 * Admin-only architecture seam for an external OAuth effecter. The public
 * Worker does not own provider redirects or receive authorization codes.
 */
app.post("/admin/platform/oauth/state/issue", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const blocked = await ensureCuratedOAuthMarketplace(c, body);
  if (blocked) return blocked;
  return forwardOAuthState(c, "/issue", body);
});

/** Consume the one-use state after an external effecter completes its flow. */
app.post("/admin/platform/oauth/state/consume", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const blocked = await ensureCuratedOAuthMarketplace(c, body);
  if (blocked) return blocked;
  return forwardOAuthState(c, "/consume", body);
});

app.post("/admin/platform/oauth", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/oauth", body);
});

app.post("/admin/platform/oauth/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/oauth/get", body);
});

app.post("/admin/platform/oauth/revoke", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/oauth/revoke", body);
});

app.post("/admin/platform/billing/plan", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/billing/plan", body);
});

app.post("/admin/platform/billing/plan/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/billing/plan/get", body);
});

app.post("/admin/platform/billing/check", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/billing/check", body);
});

app.post("/admin/platform/meter", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/meter", body);
});

app.post("/admin/platform/meter/list", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/meter/list", body);
});

app.post("/admin/platform/memory/policy", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/memory/policy", body);
});

app.post("/admin/platform/memory/policy/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/memory/policy/get", body);
});

app.post("/admin/platform/memory/deletion", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/memory/deletion", body);
});

app.post("/admin/platform/memory/deletion/receipt", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/memory/deletion/receipt", body);
});

app.post("/admin/platform/memory/deletion/get", requireAdminAuth(), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  if (typeof body.tenantId !== "string") return c.json({ error: "tenant_id_required" }, 400);
  return forwardPlatformState(c, platformTenantObjectName(body.tenantId), "/memory/deletion/get", body);
});

app.get("/admin/permissions", requireAdminAuth(), async (c) => {
  const teamId = c.req.query("teamId")?.trim() ?? "";
  const channelId = c.req.query("channelId")?.trim() ?? "";
  if (
    !teamId ||
    !channelId ||
    teamId.length > 256 ||
    channelId.length > 256
  ) {
    return c.json(
      { error: "teamId and channelId are required and must be <= 256 chars" },
      400,
      { "cache-control": "no-store" },
    );
  }
  const { config, bundle } = await loadTurnAccess(
    c.env.WORKSPACE_CONFIG,
    teamId,
    channelId,
  );
  const allowed = new Set(
    resolveAllowedTools([...ALL_EDGE_TOOL_NAMES], bundle),
  );
  if (config.policies.allowMemoryWrite === false) {
    allowed.delete("memory_write");
  }
  if (config.policies.allowTasks === false) {
    allowed.delete("start_task");
    allowed.delete("research_progress");
  }
  allowed.add("show_permissions");
  const snapshot = buildPermissionSnapshot({
    teamId,
    channelId,
    actor: { kind: "operator" },
    config,
    bundle,
    allToolNames: ALL_EDGE_TOOL_NAMES,
    allowedTools: allowed,
    runtime: {
      ...(config.runtimeDefaults?.harnessType
        ? { harnessType: config.runtimeDefaults.harnessType }
        : {}),
      ...(config.runtimeDefaults?.model
        ? { model: config.runtimeDefaults.model }
        : {}),
      harnessSource: config.runtimeDefaults?.harnessType
        ? "channel"
        : "deployment",
      modelSource: config.runtimeDefaults?.model
        ? "channel"
        : "deployment",
      harnessConnected: Boolean(c.env.HARNESS || c.env.HARNESS_URL),
    },
  });
  console.log(JSON.stringify({
    metric: "permission_snapshot_generated",
    actorKind: "operator",
    surface: "admin",
  }));
  return c.json(snapshot, 200, { "cache-control": "no-store" });
});

function knowledgeSourceActionHandler(action: KnowledgeSourceAction) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    try {
      const request = parseKnowledgeSourceAdminRequest(action, await c.req.json());
      const grant = await verifyKnowledgeSourceGrant(
        c.req.header(KNOWLEDGE_SOURCE_GRANT_HEADER),
        request,
        {
          publicKey: c.env.KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY,
          issuer: c.env.KNOWLEDGE_SOURCE_AUTH_ISSUER,
          keyId: c.env.KNOWLEDGE_SOURCE_AUTH_KEY_ID,
        },
      );
      const stub = tenantStub(c.env.WORKSPACE_CONFIG, request.teamId);
      const response = await stub.fetch("https://do/authorizedTrackedKnowledgeSourceAction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request, grant }),
      });
      if (!response.ok) {
        return Response.json(
          { error: "knowledge_source_control_plane_unavailable" },
          { status: response.status >= 500 ? 503 : 400, headers: { "cache-control": "no-store" } },
        );
      }
      const result = await response.json() as {
        ok?: boolean;
        status?: number;
        error?: string;
      };
      const status = result.ok === false
        ? result.status === 409 ? 409 : 400
        : 200;
      return Response.json(result, {
        status,
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      const status = error instanceof KnowledgeSourceAuthorizationError
        ? error.status
        : 400;
      return Response.json(
        {
          error: error instanceof Error
            ? error.message
            : "knowledge_source_action_failed",
        },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

// Source lifecycle grants are minted only by a separately approved external
// authority. ADMIN_SECRET remains a second control-plane credential and cannot
// mint or broaden the signed exact team/project/channel/action authority.
app.post(
  "/admin/knowledge/sources/inspect",
  requireAdminAuth(),
  knowledgeSourceActionHandler("inspect"),
);
app.post(
  "/admin/knowledge/sources/list",
  requireAdminAuth(),
  knowledgeSourceActionHandler("list_exact"),
);
app.post(
  "/admin/knowledge/sources/stage",
  requireAdminAuth(),
  knowledgeSourceActionHandler("stage_disabled"),
);
app.post(
  "/admin/knowledge/sources/update-disabled",
  requireAdminAuth(),
  knowledgeSourceActionHandler("update_disabled"),
);
app.post(
  "/admin/knowledge/sources/enable-first",
  requireAdminAuth(),
  knowledgeSourceActionHandler("enable_first"),
);
app.post(
  "/admin/knowledge/sources/disable",
  requireAdminAuth(),
  knowledgeSourceActionHandler("disable"),
);

app.post("/admin/knowledge/reconcile", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as {
      teamId?: string;
      runId?: string;
      limit?: number;
    };
    const result = await runKnowledgeReconciliationPage(c.env, {
      teamId: body.teamId ?? "",
      runId: body.runId,
      limit: body.limit,
    });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge reconciliation failed" },
      400,
      { "cache-control": "no-store" },
    );
  }
});

app.post("/admin/knowledge/actors/revoke", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as { teamId?: unknown; actorId?: unknown };
    const teamId = assertTenantId(typeof body.teamId === "string" ? body.teamId : "");
    if (typeof body.actorId !== "string" || !body.actorId.trim() || body.actorId.length > 256) {
      return c.json({ error: "actor_id_invalid" }, 400, { "cache-control": "no-store" });
    }
    if (!(await revokeKnowledgeActor(c.env.KNOWLEDGE, teamId, body.actorId))) {
      return c.json({ error: "actor_revoke_unavailable" }, 503, { "cache-control": "no-store" });
    }
    return c.json({ revoked: true }, 200, { "cache-control": "no-store" });
  } catch {
    return c.json({ error: "actor_revoke_invalid" }, 400, { "cache-control": "no-store" });
  }
});

app.get("/admin/knowledge/dlq", requireAdminAuth(), async (c) => {
  try {
    const cursor = Number(c.req.query("cursor") ?? "0");
    const limit = Number(c.req.query("limit") ?? "25");
    const result = await inspectDurableKnowledgeDlq(c.env, { cursor, limit });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge DLQ inspection failed" },
      400,
      { "cache-control": "no-store" },
    );
  }
});

app.post("/admin/knowledge/dlq/:recordId/replay", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as {
      expectedSourceKey?: string;
      rootCauseCorrectionRef?: string;
    };
    const result = await replayDurableKnowledgeDlqRecord(c.env, {
      recordId: c.req.param("recordId"),
      expectedSourceKey: body.expectedSourceKey ?? "",
      rootCauseCorrectionRef: body.rootCauseCorrectionRef ?? "",
    });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge DLQ replay failed" },
      409,
      { "cache-control": "no-store" },
    );
  }
});

app.post("/admin/knowledge/backfill/discover", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as {
      manifestId?: string;
      teamId?: string;
      projectId?: string;
      channelIds?: string[];
      from?: string;
      to?: string;
      maximumCount?: number;
      maximumRatePerMinute?: number;
      maximumErrors?: number;
      releaseIds?: string[];
      rollbackOwner?: string;
    };
    const allowed = new Set([
      "manifestId",
      "teamId",
      "projectId",
      "channelIds",
      "from",
      "to",
      "maximumCount",
      "maximumRatePerMinute",
      "maximumErrors",
      "releaseIds",
      "rollbackOwner",
    ]);
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((key) => !allowed.has(key))
    ) {
      throw new Error("backfill discovery request contains unexpected fields");
    }
    const result = await discoverAndStoreKnowledgeBackfill(c.env, {
      manifestId: body.manifestId ?? "",
      teamId: body.teamId ?? "",
      projectId: body.projectId ?? "",
      channelIds: body.channelIds ?? [],
      from: body.from ?? "",
      to: body.to ?? "",
      maximumCount: body.maximumCount ?? 0,
      maximumRatePerMinute: body.maximumRatePerMinute ?? 0,
      maximumErrors: body.maximumErrors ?? -1,
      releaseIds: body.releaseIds ?? [],
      rollbackOwner: body.rollbackOwner ?? "",
    });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge backfill discovery failed" },
      400,
      { "cache-control": "no-store" },
    );
  }
});

app.post("/admin/knowledge/backfill/:manifestId/approve", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as {
      teamId?: string;
      manifestDigest?: string;
    };
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((key) =>
        key !== "teamId" && key !== "manifestDigest")
    ) {
      throw new KnowledgeBackfillApprovalError(
        "knowledge_backfill_approval_request_contains_untrusted_fields",
        400,
      );
    }
    const result = await approveKnowledgeBackfillManifest(c.env, {
      teamId: body.teamId ?? "",
      manifestId: c.req.param("manifestId"),
      manifestDigest: body.manifestDigest ?? "",
      approvalArtifact: c.req.header(KNOWLEDGE_BACKFILL_APPROVAL_HEADER),
      verifier: {
        publicKey: c.env.KNOWLEDGE_BACKFILL_APPROVAL_PUBLIC_KEY,
        issuer: c.env.KNOWLEDGE_BACKFILL_APPROVAL_ISSUER,
        keyId: c.env.KNOWLEDGE_BACKFILL_APPROVAL_KEY_ID,
      },
    });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    const status = error instanceof KnowledgeBackfillApprovalError
      ? error.status
      : 409;
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge backfill approval failed" },
      status,
      { "cache-control": "no-store" },
    );
  }
});

app.post("/admin/knowledge/backfill/:manifestId/execute", requireAdminAuth(), async (c) => {
  try {
    const body = await c.req.json() as {
      teamId?: string;
      manifestDigest?: string;
      batchLimit?: number;
    };
    const result = await executeKnowledgeBackfillPage(c.env, {
      teamId: body.teamId ?? "",
      manifestId: c.req.param("manifestId"),
      manifestDigest: body.manifestDigest ?? "",
      batchLimit: body.batchLimit,
    });
    return c.json(
      result,
      result.pageStatus === "partial" ? 409 : 200,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "knowledge backfill execution failed" },
      409,
      { "cache-control": "no-store" },
    );
  }
});

/**
 * MCP-style knowledge retrieval primitives (K2 Phase 5).
 * Bearer ADMIN_SECRET; LLM-light raw citations; no ingestion.
 */
app.post("/mcp/knowledge", async (c) => handleKnowledgeMcp(c.req.raw, c.env));

/** Seed a pending HITL action snapshot key (admin/debug). */
app.post("/debug/hitl", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as {
    actionId: string;
    conversationKey: string;
    summary?: string;
  };
  const store = createDurableObjectStore(c.env.BOT_STATE);
  await store.kv.set(
    `hitl:${body.actionId}`,
    {
      actionId: body.actionId,
      conversationKey: body.conversationKey,
      summary: body.summary ?? "approve?",
      status: "pending",
    },
    86_400_000,
  );
  const got = await store.kv.get(`hitl:${body.actionId}`);
  return c.json({ ok: true, gate: got });
});

app.post("/tasks/start", requireAdminAuth(), async (c) => {
  const body = await c.req.json();
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { type?: string }).type !== "research"
  ) {
    return c.json(
      { error: "only type=research is supported until Track F" },
      400,
    );
  }
  const result = await startTask(c.env, body as never);
  return c.json(result);
});

app.post("/slack/events", slackVerify(), async (c) => {
  const payload = c.get("slackPayload") as {
    type?: string;
    challenge?: string;
    team_id?: string;
  } & SlackEventCallbackPayload;

  if (payload?.type === "url_verification" && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const teamId = payload.team_id ?? "unknown";
  const trustedConfig = parseTrustedTriggerConfig(
    c.env.SLACK_BOT_USER_ID,
    c.env.SLACK_TRUSTED_TRIGGER_ACTORS,
  );
  const exec = c.executionCtx;
  const event = payload.event as {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: LateFileEvent["files"];
  } | undefined;
  const store = createDurableObjectStore(c.env.BOT_STATE);

  // Slack may deliver an app_mention before its uploaded file metadata. Match
  // the later file_share to the exact user/channel mention, wait for that
  // original turn to become idle, hydrate files.info, then admit one synthetic
  // continuation with a stable event id. Replays hit the ordinary durable
  // pre-admission dedupe and can never create a second turn.
  if (
    event?.channel && event.user && event.ts &&
    Array.isArray(event.files) && event.files.length > 0
  ) {
    const scopeKey = pendingLateFileScopeKey({
      teamId,
      channelId: event.channel,
      userId: event.user,
    });
    const pendingRows = await store.list.range<PendingFilelessMention>(
      scopeKey,
      0,
      -1,
    );
    const unconsumed = (
      await Promise.all(pendingRows.map(async (pending) => ({
        pending,
        consumed: Boolean(await store.kv.get(consumedLateFileKey(pending))),
      })))
    ).filter((entry) => !entry.consumed).map((entry) => entry.pending);
    const candidate: LateFileEvent = {
      teamId,
      channelId: event.channel,
      userId: event.user,
      fileTs: event.ts,
      threadTs: event.thread_ts,
      files: event.files,
    };
    const selection = selectPendingLateFileMention(unconsumed, candidate);
    if (selection.status === "ambiguous") {
      console.error("[slack/events:late-file] ambiguous pending mention", {
        teamId,
        channelId: event.channel,
        userId: event.user,
      });
      return c.json({ error: "late_file_correlation_ambiguous" }, 409);
    }
    if (selection.status === "matched") {
      const pending = selection.pending;
      const jobId = lateFileRepairDedupeKey(pending, candidate);
      try {
        await deferredIngressStub(c.env, jobId).prepare({
          id: jobId,
          kind: "late_file",
          payload: {
            callback: payload,
            pending,
            candidate,
          } satisfies LateFileRepairJobPayload,
          teamId,
        });
      } catch (error) {
        console.error("[slack/events:late-file] durable ownership failed", error);
        return c.json({ error: "late_file_persistence_failed" }, 503);
      }
      return c.json({ ok: true });
    }
  }

  // Stop-command routing (GOAL.md Phase A2 Task 1): a matching stop phrase
  // never reaches the bot engine — it interrupts the session + clears
  // status/obligation instead. Anything that isn't a stop command (including
  // a message that merely fails the stop-phrase check) falls through to the
  // normal routing below, unchanged.
  const stopEvent = extractStopCommandEvent(payload, trustedConfig.botUserId);
  if (stopEvent) {
    const runStop = () => handleStopCommand(c.env, stopEvent, payload.event_id);
    if (exec?.waitUntil) {
      exec.waitUntil(
        runStop().catch((err) => console.error("[slack/events:stop]", err)),
      );
    } else {
      await runStop();
    }
    return c.json({ ok: true });
  }

  // Automatic ingestion scheduling is independent of the turn path. HMAC has
  // already been verified by slackVerify(); only exact enabled config rows can
  // create descriptors, and Queue/Supermemory work remains outside this ack.
  // Exact Stop remains a control-plane continuation and is not captured.
  if (exec?.waitUntil) {
    exec.waitUntil(
      scheduleKnowledgeFromSlackEvent(c.env, payload).catch((error) => {
        console.error(
          "[slack/events:knowledge] descriptor scheduling failed",
          error instanceof Error ? error.message : "unknown",
        );
      }),
    );
  }

  const trustedDecision = trustedRichTriggerDecision(
    payload.event,
    trustedConfig,
  );
  if (trustedDecision.reason) {
    console.log(JSON.stringify({
      metric: "trusted_rich_mention_ignored",
      reason: trustedDecision.reason,
    }));
  }

  // File-bearing ordinary turns use the same immutable callback owner as late
  // repairs. The callback and alarm exist before 200; R2/session admission can
  // then fail and retry after isolate loss without losing the attachment.
  const fileIdentity = preAdmissionIdentityForEvent(payload, trustedConfig);
  if (
    fileIdentity &&
    Array.isArray(event?.files) &&
    event.files.length > 0
  ) {
    const jobId = `file-turn:${fileIdentity.eventId}`;
    try {
      await deferredIngressStub(c.env, jobId).prepare({
        id: jobId,
        kind: "file_turn",
        payload: { callback: payload } satisfies FileTurnJobPayload,
        teamId,
      });
    } catch (error) {
      console.error("[slack/events:file-turn] durable ownership failed", error);
      return c.json({ error: "file_turn_persistence_failed" }, 503);
    }
    return c.json({ ok: true });
  }

  const run = async () => {
    const identity = preAdmissionIdentityForEvent(payload, trustedConfig);
    const admission = await preAdmitSlackTurnResult(c.env, identity);
    if (identity && admission.status !== "accepted") {
      if (admission.status === "duplicate") {
        console.log(JSON.stringify({ metric: "turn_duplicate_pre_admission", eventId: identity.eventId }));
        if (identity.actor.kind === "slack_automation") {
          console.log(JSON.stringify({
            metric: "trusted_rich_mention_ignored",
            reason: "duplicate",
          }));
        }
        return;
      }
      if (admission.status === "concurrent") {
        const stateStore = createBotStoreAdapter(c.env.BOT_STATE);
        await postTurnRejectedFeedback(c.env, stateStore, {
          reason: "concurrent",
          channelId: identity.channelId,
          threadTs: identity.threadTs,
          threadKey: slackObligationThreadKey(identity.teamId, identity.channelId, identity.threadTs),
        });
        return;
      }
      return;
    }
    const preAdmittedTurn = admission.status === "accepted" ? admission.turn : undefined;
    if (identity?.actor.kind === "slack_automation") {
      console.log(JSON.stringify({
        metric: "trusted_rich_mention_admitted",
        actorKind: identity.actor.kind,
      }));
    }
    let handedOff = false;
    try {
      const { adapter } = await getOrCreateBot(c.env);
      await adapter.handleEventsBody(payload, {
        teamId,
        preAdmittedTurn,
        onTurnHandoff: () => { handedOff = true; },
      });
    } finally {
      if (!handedOff) await abandonPreAdmittedTurn(c.env, preAdmittedTurn);
    }
  };

  // Correlation ownership must exist before Slack receives 200; otherwise an
  // isolate loss can make a later file_share impossible to associate.
  const eventIdentity = preAdmissionIdentityForEvent(
    payload,
    trustedConfig,
  );
  if (
    eventIdentity && event?.type === "app_mention" &&
    (!Array.isArray(event.files) || event.files.length === 0)
  ) {
    const pending: PendingFilelessMention = {
      teamId,
      channelId: eventIdentity.channelId,
      userId: eventIdentity.requesterId,
      mentionTs: eventIdentity.inboundTs,
      threadTs: eventIdentity.threadTs ?? eventIdentity.inboundTs,
      eventId: eventIdentity.eventId,
      expiresAt: Date.now() + LATE_FILE_WINDOW_MS,
    };
    try {
      await store.list.append(
        pendingLateFileScopeKey(pending),
        pending,
        { maxLen: 32, ttlMs: LATE_FILE_WINDOW_MS },
      );
    } catch (error) {
      console.error("[slack/events] late-file correlation persistence failed", error);
      return c.json({ error: "late_file_correlation_persistence_failed" }, 503);
    }
  }

  if (exec?.waitUntil) {
    exec.waitUntil(
      run().catch(async (err) => {
        console.error("[slack/events]", err);
        // Best-effort: waitUntil cancellation leaves no reply otherwise.
      }),
    );
  } else {
    await run();
  }
  return c.json({ ok: true });
});

app.post("/slack/commands", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  const params = new URLSearchParams(raw);
  const body = {
    command: params.get("command") ?? undefined,
    text: params.get("text") ?? undefined,
    channel_id: params.get("channel_id") ?? undefined,
    user_id: params.get("user_id") ?? undefined,
    trigger_id: params.get("trigger_id") ?? undefined,
    team_id: params.get("team_id") ?? undefined,
    thread_ts: params.get("thread_ts") ?? undefined,
  };

  const teamId = body.team_id ?? "unknown";

  if (!body.trigger_id) {
    return c.json({ error: "missing_stable_command_identity" }, 400);
  }

  const identity = preAdmissionIdentityForCommand(body);
  const admission = identity
    ? await preAdmitSlackTurnResult(c.env, identity)
    : undefined;

  // Immediate ack for Slack's 3s deadline; work continues in waitUntil.
  const run = async () => {
    if (identity && admission && admission.status !== "accepted") {
      if (admission.status === "duplicate") {
        console.log(JSON.stringify({ metric: "turn_duplicate_pre_admission", eventId: identity.eventId }));
        return;
      }
      if (admission.status === "concurrent") {
        const stateStore = createBotStoreAdapter(c.env.BOT_STATE);
        await postTurnRejectedFeedback(c.env, stateStore, {
          reason: "concurrent",
          channelId: identity.channelId,
          threadTs: identity.threadTs,
          threadKey: slackObligationThreadKey(identity.teamId, identity.channelId, identity.threadTs),
        });
        return;
      }
      return;
    }
    const preAdmittedTurn = admission?.status === "accepted" ? admission.turn : undefined;
    let handedOff = false;
    try {
      const { adapter } = await getOrCreateBot(c.env);
      await adapter.handleCommandBody(body, {
        preAdmittedTurn,
        onTurnHandoff: () => { handedOff = true; },
      });
    } finally {
      if (!handedOff) await abandonPreAdmittedTurn(c.env, preAdmittedTurn);
    }
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(run().catch((err) => console.error("[slack/commands]", err)));
  } else {
    await run();
  }

  if (identity && admission && admission.status === "duplicate") {
    return c.json({
      response_type: "ephemeral",
      text: "Already handling that command.",
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: "Working on it…",
  });
});

app.post("/slack/interactions", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  let payload: unknown;
  try {
    const params = new URLSearchParams(raw);
    payload = JSON.parse(params.get("payload") ?? raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const teamId =
    typeof payload === "object" &&
    payload !== null &&
    "team" in payload &&
    typeof (payload as { team?: { id?: string } }).team?.id === "string"
      ? (payload as { team: { id: string } }).team.id
      : "unknown";

  // quick_* buttons become synthetic agent turns (SPEC §3.4) — routed INSTEAD
  // of the generic interaction path so a click is never double-handled.
  const isQuick = isQuickInteraction(payload);
  if (isQuick && !quickActionEventId(payload)) {
    return c.json({ error: "missing_stable_click_identity" }, 400);
  }
  const run = async () => {
    const { adapter } = await getOrCreateBot(c.env);
    await adapter.handleInteractionPayload(payload);
  };

  // HITL buttons must not be acknowledged until BOT_STATE has durably
  // received the choice. A 503 is observable and retryable by Slack; returning
  // 200 from waitUntil after a failed write would silently lose the decision.
  if (!isQuick) {
    try {
      await run();
    } catch (err) {
      console.error("[slack/interactions] durable handling failed", err);
      return c.json({ error: "interaction_persistence_failed" }, 503);
    }
    return c.json({ ok: true });
  }


  // The complete immutable click is owned by a Durable Object alarm before
  // acknowledgement. An isolate can disappear after 200 without losing work.
  const jobId = quickActionEventId(payload)!;
  try {
    await deferredIngressStub(c.env, jobId).prepare({
      id: jobId,
      kind: "quick_action",
      payload,
      teamId,
    });
  } catch (err) {
    console.error("[slack/interactions] quick durable ownership failed", err);
    return c.json({ error: "interaction_persistence_failed" }, 503);
  }
  return c.json({ ok: true });
});

type QueueAndScheduledApp = typeof app & {
  queue(batch: MessageBatch<KnowledgeJob | PlatformEffectWakeup>, env: AppEnv["Bindings"], ctx: ExecutionContext): Promise<void>;
  scheduled(controller: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext): void;
};

const worker = app as QueueAndScheduledApp;
worker.queue = async (batch, env, _ctx) => {
  const platformEffectsDlqName = env.PLATFORM_EFFECTS_QUEUE_NAME
    ? `${env.PLATFORM_EFFECTS_QUEUE_NAME}-dlq`
    : undefined;
  if (
    env.PLATFORM_EFFECTS_QUEUE_NAME &&
    (batch.queue === env.PLATFORM_EFFECTS_QUEUE_NAME || batch.queue === platformEffectsDlqName)
  ) {
    if (!isPlatformEffectQueueName(env.PLATFORM_EFFECTS_QUEUE_NAME)) {
      batch.retryAll({ delaySeconds: 60 });
      throw new Error("platform_effect_queue_name_invalid");
    }
    if (
      batch.queue === env.KNOWLEDGE_QUEUE_NAME ||
      batch.queue === env.KNOWLEDGE_DLQ_NAME
    ) {
      batch.retryAll({ delaySeconds: 60 });
      throw new Error("platform_effect_queue_name_conflicts_with_knowledge_queue");
    }
    await handlePlatformEffectQueue(batch as MessageBatch<PlatformEffectWakeup>, env);
    return;
  }
  let route: "primary" | "dlq";
  try {
    route = routeKnowledgeQueueName(batch.queue, env);
  } catch (error) {
    retryKnowledgeBatchWithoutParsing(batch as MessageBatch<KnowledgeJob>);
    console.error(JSON.stringify({
      metric: "knowledge_queue_routing_error",
      queueName: batch.queue,
      errorCode: error instanceof Error ? error.message : "unknown",
    }));
    throw error;
  }
  if (route === "dlq") {
    await handleKnowledgeDlq(batch as MessageBatch<KnowledgeJob>, env);
    return;
  }
  await handleKnowledgeQueue(batch as MessageBatch<KnowledgeJob>, env, dispatchKnowledgeToSupermemory);
};
worker.scheduled = (controller, env, ctx) => {
  const scheduledAt = new Date(controller.scheduledTime).toISOString();
  ctx.waitUntil(
    runScheduledKnowledgeReconciliation(env, { scheduledAt }).catch((error) => {
      console.error(JSON.stringify({
        metric: "knowledge_reconcile_scheduler_entry_error",
        errorCode: error instanceof Error ? error.message.slice(0, 256) : "unknown",
      }));
      throw error;
    }),
  );
};

export default worker;
