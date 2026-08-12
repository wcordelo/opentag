import { describe, expect, it } from "vitest";
import { supermemoryContainerEnv } from "../workers/supermemory/src/container-env.js";
import type { Env } from "../workers/supermemory/src/env.js";

describe("Supermemory Container environment boundary", () => {
  it("passes provider material and only Container-scoped R2 credentials", () => {
    const values = supermemoryContainerEnv({
      SUPERMEMORY_SERVICE_AUTH_TOKEN: "facade-token",
      R2_ACCESS_KEY_ID: "r2-access-secret",
      R2_SECRET_ACCESS_KEY: "r2-secret-secret",
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "opentag-supermemory-state",
      OPENAI_API_KEY: "provider-token",
      OPENAI_BASE_URL: "https://openai.example/v1",
      OPENAI_MODEL: "gpt-5.1",
      SUPERMEMORY_DISABLE_TELEMETRY: "1",
    } as Env);

    expect(values).toMatchObject({
      SUPERMEMORY_DATA_DIR: "/var/lib/supermemory",
      AWS_ACCESS_KEY_ID: "r2-access-secret",
      AWS_SECRET_ACCESS_KEY: "r2-secret-secret",
      R2_ACCOUNT_ID: "account-id",
      R2_BUCKET_NAME: "opentag-supermemory-state",
      OPENAI_API_KEY: "provider-token",
      OPENAI_BASE_URL: "https://openai.example/v1",
      SUPERMEMORY_DISABLE_TELEMETRY: "1",
    });
    expect(values).not.toHaveProperty("SUPERMEMORY_SERVICE_AUTH_TOKEN");
    expect(values).not.toHaveProperty("STATE_BUCKET");
    expect(values).not.toHaveProperty("R2_ACCESS_KEY_ID");
    expect(values).not.toHaveProperty("R2_SECRET_ACCESS_KEY");
    expect(values).not.toHaveProperty("SUPERMEMORY_ALLOW_LOCAL_DISK");
  });

  it("prefers the DeepSeek credential when both provider secrets exist", () => {
    const values = supermemoryContainerEnv({
      DEEPSEEK_API_KEY: "deepseek-token",
      OPENAI_API_KEY: "openai-token",
      OPENAI_BASE_URL: "https://api.deepseek.com/",
    } as Env);

    expect(values.OPENAI_API_KEY).toBe("deepseek-token");
  });
});
