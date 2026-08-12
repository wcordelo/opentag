import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { GraphBuilderContainer, GraphQueryContainer } from "./container.js";
import type { GraphifyRegistryDO } from "./registry-do.js";

export interface Env {
  GRAPHIFY: DurableObjectNamespace<GraphQueryContainer>;
  GRAPHIFY_BUILDER: DurableObjectNamespace<GraphBuilderContainer>;
  REGISTRY: DurableObjectNamespace<GraphifyRegistryDO>;
  ARTIFACTS: R2Bucket;
  GRAPHIFY_COMMIT: string;
  GRAPHIFY_ALLOWED_REPO_ORGS: string;
  GRAPHIFY_DEFAULT_TEAM_ID: string;
  GRAPHIFY_DEFAULT_PROJECT_ID: string;
  /** JSON object mapping server-owned repoIds to tracked GitHub sources. */
  GRAPHIFY_REPOSITORY_CATALOG?: string;
  GRAPHIFY_SERVICE_AUTH_TOKEN?: string;
  GRAPHIFY_ADMIN_TOKEN?: string;
  GRAPHIFY_CONTAINER_AUTH_TOKEN?: string;
  GITHUB_TOKEN?: string;
}
