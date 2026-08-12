import { describe, expect, it } from "vitest";
import {
  graphBuilderContainerEnv,
  graphQueryContainerEnv,
  type GraphifyContainerEnvSource,
} from "../workers/graphify/src/container-env.js";

const source: GraphifyContainerEnvSource = {
  GRAPHIFY_CONTAINER_AUTH_TOKEN: "container-token",
  GRAPHIFY_COMMIT: "00efd6e7969837ae4a9f11d8d504dcd3b20b09df",
  GRAPHIFY_ALLOWED_REPO_ORGS: "wcordelo",
  GITHUB_TOKEN: "github-token",
};

describe("Graphify Container role environments", () => {
  it("passes the binding mount path and query token to the query role", () => {
    expect(graphQueryContainerEnv(source)).toMatchObject({
      GRAPHIFY_R2_MOUNT: "/mnt/graphs",
      GRAPHIFY_CONTAINER_AUTH_TOKEN: "container-token",
    });
    expect(graphQueryContainerEnv(source)).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(graphQueryContainerEnv(source)).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(graphQueryContainerEnv(source)).not.toHaveProperty("R2_BUCKET_NAME");
  });

  it("does not pass R2 or GitHub credentials to the builder role", () => {
    const values = graphBuilderContainerEnv(source);
    expect(values).toMatchObject({
      GRAPHIFY_COMMIT: source.GRAPHIFY_COMMIT,
      GRAPHIFY_CONTAINER_AUTH_TOKEN: "container-token",
      GITHUB_TOKEN: "github-token",
    });
    expect(values).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(values).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(values).not.toHaveProperty("R2_BUCKET_NAME");
  });
});
