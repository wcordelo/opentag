import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  loadTurnAccess,
  verifyConnectorAuthorization,
} from "../config/workspace-config-do.js";
import {
  isConnectorAuthorizationUnavailable,
  loadPlatformConnectorAuthorization,
} from "../connectors/platform-authorization.js";
import { DriveConnectorError, DRIVE_SEARCH_LIMITS, searchGoogleDrive } from "../memory/connectors/drive-connector.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

export type SearchDriveResult =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
  | { status: "unauthorized"; citations: []; reason: "policy_denied" }
  | { status: "knowledge_unavailable"; citations: []; retryable: boolean };

export function createSearchDriveTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "search_drive",
    description: "Search the explicitly authorized Google Drive scope. Results include revisioned citations and never expose credential material.",
    parameters: z.object({
      query: z.string().min(1).max(DRIVE_SEARCH_LIMITS.maxQueryLength),
      projectId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(DRIVE_SEARCH_LIMITS.maxLimit).optional(),
    }).strict(),
    async handler({ query, projectId, limit }, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      if (
        !snapshot.channelAccess.allowedTools.includes("search_drive") ||
        snapshot.scope.teamId !== context.teamId ||
        snapshot.scope.channelId !== channelId
      ) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies SearchDriveResult;
      }
      const env = dependencies.env();
      try {
        const { bundle } = await loadTurnAccess(env.WORKSPACE_CONFIG, context.teamId, channelId);
        const platformAuthorization = await loadPlatformConnectorAuthorization({
          env,
          context,
          channelId,
          projectId,
          executionId: exact.executionId,
          threadKey: exact.threadKey,
          connectorId: "google_drive",
          action: "search",
        });
        const authorization = platformAuthorization.authorization;
        if (!authorization.credential) {
          return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies SearchDriveResult;
        }
        const citations = await searchGoogleDrive({
          workspaceId: context.teamId,
          projectId,
          query,
          limit,
          labels: authorization.labels,
          bundle,
          credential: authorization.credential,
          credentialBroker: env.CONNECTOR_CREDENTIALS,
          brokerAuthToken: env.CONNECTOR_CREDENTIAL_BROKER_TOKEN,
          revalidate: async () => verifyConnectorAuthorization(env.WORKSPACE_CONFIG, authorization.labels),
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies SearchDriveResult;
      } catch (error) {
        if (error instanceof DriveConnectorError) {
          return { status: "knowledge_unavailable", citations: [], retryable: error.retryable } satisfies SearchDriveResult;
        }
        if (isConnectorAuthorizationUnavailable(error)) {
          return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies SearchDriveResult;
        }
        if (error instanceof Error && /unauthorized|authorization|revoked|grant|policy|scope/.test(error.message)) {
          return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies SearchDriveResult;
        }
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies SearchDriveResult;
      }
    },
  });
}
