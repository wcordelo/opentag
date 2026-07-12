/**
 * Integration coverage plan + executable smoke checks for pieces that do not
 * need Miniflare DO bindings. Full workers-pool e2e remains behind
 * `npm run test:workers` once service bindings are provisioned.
 */
import { describe, expect, it } from "vitest";
import { classify } from "../../workers/wasm-dispatch/src/index";
import egress from "../../workers/egress-proxy/src/index";

describe("pipeline smoke (no live Slack / no deploy)", () => {
  it("research intent routes through WASM classify contract", () => {
    const r = classify("<@U1> research: OpenTag cold start");
    expect(r.intent).toBe("research");
    expect(r.extractedObjective).toBe("OpenTag cold start");
  });

  it("egress proxy rejects non-allowlisted hosts (M4 security invariant)", async () => {
    const env = {
      ALLOWED_HOSTS: ["api.anthropic.com"],
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "",
      ORCHESTRATOR_SERVICE: {
        fetch: async () => Response.json({ ok: true }),
      } as unknown as Fetcher,
    };
    const res = await egress.fetch(
      new Request("https://egress/proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://evil.example/x",
          method: "GET",
          teamId: "T1",
        }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe.skip("Full Miniflare DO e2e (enable with test:workers + bindings)", () => {
  it.todo("POST /research creates task readable via OrchestratorDO GET /tasks/:id");
  it.todo("duplicate Slack event_id does not create a second task in DO SQLite");
  it.todo("container start posts cold-start Slack ack before sandbox is ready");
});
