import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAdminAuth } from "../src/admin-auth.js";
import type { AppEnv, Env } from "../src/env.js";

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    BOT_STATE: {} as Env["BOT_STATE"],
    WORKSPACE_CONFIG: {} as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: {} as Env["KNOWLEDGE"],
    SESSION_EVENTS: {} as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    AGENT_URL: "",
    ...over,
  };
}

describe("requireAdminAuth", () => {
  it("allows missing secret in development", async () => {
    const app = new Hono<AppEnv>();
    app.post("/admin/x", requireAdminAuth(), (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://t/admin/x", { method: "POST" }),
      baseEnv({ ENVIRONMENT: "development" }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects bad bearer when secret set", async () => {
    const app = new Hono<AppEnv>();
    app.post("/admin/x", requireAdminAuth(), (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://t/admin/x", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
      baseEnv({ ENVIRONMENT: "production", ADMIN_SECRET: "correct" }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts matching bearer", async () => {
    const app = new Hono<AppEnv>();
    app.post("/admin/x", requireAdminAuth(), (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://t/admin/x", {
        method: "POST",
        headers: { Authorization: "Bearer correct" },
      }),
      baseEnv({ ENVIRONMENT: "production", ADMIN_SECRET: "correct" }),
    );
    expect(res.status).toBe(200);
  });
});
