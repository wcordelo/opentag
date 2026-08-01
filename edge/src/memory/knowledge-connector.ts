/**
 * K2 Phase 1 connector registry types.
 *
 * Slack remains special-cased in the Queue dispatch / SupermemoryAdapter path
 * until Phase 2 wires concrete connectors. CONNECTOR_REGISTRY starts empty so
 * ingestion does not silently route through an unfinished plugin surface.
 */

import type { FlatMetadata, KnowledgeCitationBase, KnowledgeJob } from "./knowledge-contract.js";
import type { KnowledgeSourceType } from "./knowledge-source-types.js";

export type KnowledgeNormalizedDocument = {
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  content: string;
  revision: string;
  metadata: FlatMetadata;
};

export type KnowledgeIngestConnector = {
  sourceType: KnowledgeSourceType;
  fetchAndNormalize(
    job: KnowledgeJob,
    env: unknown,
  ): Promise<
    | { status: "complete"; document: KnowledgeNormalizedDocument }
    | { status: "incomplete"; reason: string }
  >;
};

export type KnowledgeSearchConnector = {
  sourceType: KnowledgeSourceType;
  search(input: {
    teamId: string;
    projectId: string;
    /** channelId for Slack; stable scope id within the project for other sources. */
    scopeId: string;
    aclPolicyRef: string;
    query: string;
    limit: number;
  }): Promise<KnowledgeCitationBase[]>;
};

/**
 * Optional ingest + search pair per sourceType.
 * Slack remains special-cased in Queue dispatch; wiki/code/custom_db normalize
 * helpers live under `connectors/` and are registered here for discovery.
 */
export const CONNECTOR_REGISTRY: Partial<
  Record<
    KnowledgeSourceType,
    {
      ingest?: KnowledgeIngestConnector;
      search?: KnowledgeSearchConnector;
      /** Static marker that Phase 2 normalize/search modules exist. */
      implemented?: boolean;
    }
  >
> = {
  wiki: { implemented: true },
  code: { implemented: true },
  custom_db: { implemented: true },
  drive: { implemented: true },
};
