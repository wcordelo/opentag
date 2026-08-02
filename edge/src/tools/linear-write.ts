import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  assertLinearWriteApprovalCurrent,
  createLinearIssue,
  linearWriteApprovalKey,
  normalizeLinearIssueDraft,
  type LinearWriteApproval,
  type LinearIssueCreateResult,
} from "../connectors/linear-write.js";
import {
  loadTurnAccess,
  verifyConnectorAuthorization,
} from "../config/workspace-config-do.js";
import {
  isConnectorAuthorizationUnavailable,
  loadPlatformConnectorAuthorization,
} from "../connectors/platform-authorization.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";
import { createDurableObjectStore } from "../store/index.js";
import type { BotTool } from "@copilotkit/channels";
import type { ActiveTurnEffectResource } from "../store/active-turn-types.js";

export const SAVE_LINEAR_ISSUE_TOOL_NAME = "save_linear_issue" as const;
export const LINEAR_CONNECTOR_SCOPE_PROJECT = "workspace";

type RunExactTurnEffect = <T>(
  thread: object,
  effectName: string,
  action: () => Promise<T>,
  options?: {
    resource?: (value: T) => ActiveTurnEffectResource | undefined;
    cancelIfStopped?: (resource: ActiveTurnEffectResource) => Promise<void>;
  },
) => Promise<T>;

export type SaveLinearIssueResult =
  | ({ status: "created" } & LinearIssueCreateResult)
  | { status: "unauthorized"; reason: string }
  | { status: "approval_required"; reason: string }
  | { status: "unavailable"; retryable: boolean; reason: string };

export function createSaveLinearIssueTool(dependencies: {
  env(): Env;
  assertActive(thread: object): Promise<void>;
  channel(thread: unknown): string;
  runEffect: RunExactTurnEffect;
}) {
  return defineBotTool({
    name: SAVE_LINEAR_ISSUE_TOOL_NAME,
    description:
      "Create exactly one Linear issue after the user approved the matching " +
      "confirm_write card. Pass the approvalId returned by confirm_write and " +
      "the exact approved fields; this tool never uses Linear MCP mutations.",
    parameters: z.object({
      approvalId: z.string().min(16).max(200),
      title: z.string().min(1).max(256),
      description: z.string().max(20_000).optional(),
      team: z.string().max(256).optional(),
      assigneeEmail: z.string().max(320).optional(),
      project: z.string().max(256).optional(),
      milestone: z.string().max(256).optional(),
    }).strict(),
    async handler(
      { approvalId, title, description, team, assigneeEmail, project, milestone },
      { thread },
    ): Promise<SaveLinearIssueResult> {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      if (context.actor.kind !== "slack_user") {
        return { status: "unauthorized", reason: "automation_actor_cannot_write" };
      }
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      if (
        !snapshot.channelAccess.allowedTools.includes(SAVE_LINEAR_ISSUE_TOOL_NAME) ||
        snapshot.scope.teamId !== context.teamId ||
        snapshot.scope.channelId !== channelId
      ) {
        return { status: "unauthorized", reason: "policy_denied" };
      }

      const draft = normalizeLinearIssueDraft({
        title,
        ...(description !== undefined ? { description } : {}),
        ...(team !== undefined ? { team } : {}),
        ...(assigneeEmail !== undefined ? { assigneeEmail } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(milestone !== undefined ? { milestone } : {}),
      });
      const store = createDurableObjectStore(dependencies.env().BOT_STATE);
      let approval: LinearWriteApproval | undefined;
      try {
        approval = await assertLinearWriteApprovalCurrent(
          await store.kv.get(linearWriteApprovalKey(approvalId)),
          {
            approvalId,
            teamId: context.teamId,
            channelId,
            requesterId: context.requesterId,
            executionId: exact.executionId,
            threadKey: exact.threadKey,
            draft,
          },
        );
      } catch {
        approval = undefined;
      }
      if (!approval) {
        return { status: "approval_required", reason: "approval_missing_or_mismatched" };
      }

      const env = dependencies.env();
      let access: Awaited<ReturnType<typeof loadTurnAccess>>;
      let authorization: Awaited<ReturnType<typeof loadPlatformConnectorAuthorization>>["authorization"];
      try {
        access = await loadTurnAccess(env.WORKSPACE_CONFIG, context.teamId, channelId);
        authorization = (await loadPlatformConnectorAuthorization({
          env,
          context,
          projectId: LINEAR_CONNECTOR_SCOPE_PROJECT,
          channelId,
          executionId: exact.executionId,
          threadKey: exact.threadKey,
          connectorId: "linear",
          action: "create_issue",
        })).authorization;
      } catch (error) {
        if (isConnectorAuthorizationUnavailable(error)) {
          return {
            status: "unavailable",
            retryable: true,
            reason: error instanceof Error ? error.message : "connector_authorization_unavailable",
          };
        }
        return {
          status: "unauthorized",
          reason: error instanceof Error ? error.message : "connector_authorization_unavailable",
        };
      }
      if (!authorization.credential) {
        return { status: "unauthorized", reason: "linear_credential_reference_required" };
      }

      const created = await dependencies.runEffect(
        thread,
        "linear_create_issue",
        () => createLinearIssue({
          labels: authorization.labels,
          bundle: access.bundle,
          credential: authorization.credential!,
          credentialBroker: env.CONNECTOR_CREDENTIALS,
          brokerAuthToken: env.CONNECTOR_CREDENTIAL_BROKER_TOKEN,
          draft: approval.draft,
          onIssueCreated: () => store.kv.delete(linearWriteApprovalKey(approvalId)),
          revalidate: () => verifyConnectorAuthorization(env.WORKSPACE_CONFIG, authorization.labels),
        }),
      );
      await dependencies.assertActive(thread);
      return { status: "created", ...created };
    },
  }) as BotTool;
}
