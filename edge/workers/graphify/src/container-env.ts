export type GraphifyContainerEnvSource = {
  GRAPHIFY_CONTAINER_AUTH_TOKEN?: string;
  GRAPHIFY_COMMIT: string;
  GRAPHIFY_ALLOWED_REPO_ORGS: string;
  GITHUB_TOKEN?: string;
};

/** Environment for the read-only query role. The builder never receives R2 credentials. */
export function graphQueryContainerEnv(source: GraphifyContainerEnvSource): Record<string, string> {
  const values: Record<string, string> = {
    PORT: "8080",
    GRAPHIFY_R2_MOUNT: "/mnt/graphs",
  };
  if (source.GRAPHIFY_CONTAINER_AUTH_TOKEN) values.GRAPHIFY_CONTAINER_AUTH_TOKEN = source.GRAPHIFY_CONTAINER_AUTH_TOKEN;
  return values;
}

/** Environment for the build role. It only needs GitHub read access and the pinned Graphify version. */
export function graphBuilderContainerEnv(source: GraphifyContainerEnvSource): Record<string, string> {
  const values: Record<string, string> = {
    PORT: "8080",
    GRAPHIFY_COMMIT: source.GRAPHIFY_COMMIT,
    GRAPHIFY_ALLOWED_REPO_ORGS: source.GRAPHIFY_ALLOWED_REPO_ORGS,
  };
  for (const key of ["GRAPHIFY_CONTAINER_AUTH_TOKEN", "GITHUB_TOKEN"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  return values;
}
