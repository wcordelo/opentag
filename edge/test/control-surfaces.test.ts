import { describe, expect, it, vi } from "vitest";
import {
  buildSessionViewUrl,
  createSessionViewToken,
  verifySessionViewToken,
} from "../src/slack/session-link.js";
import { interruptAguiTurn } from "../src/slack/stop-routing.js";
import { agentExecutionIdFromRequest } from "../src/bot-engine.js";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("signed session viewer", () => {
  it("round-trips a signed thread key and rejects tampering/expiry", async () => {
    const token = await createSessionViewToken("slack:C1:1.0", "secret", 1_000);
    await expect(verifySessionViewToken(token, "secret", 2_000)).resolves
      .toMatchObject({ threadKey: "slack:C1:1.0", v: 1 });
    await expect(verifySessionViewToken(`${token}x`, "secret", 2_000)).resolves
      .toBeUndefined();
    await expect(verifySessionViewToken(token, "wrong", 2_000)).resolves
      .toBeUndefined();
    await expect(verifySessionViewToken(token, "secret", 8 * 24 * 60 * 60_000))
      .resolves.toBeUndefined();
  });

  it("builds an encoded viewer URL", async () => {
    const url = await buildSessionViewUrl({
      baseUrl: "https://bot.example/",
      secret: "secret",
      threadKey: "slack:C1:1.0",
    });
    expect(url).toMatch(/^https:\/\/bot\.example\/sessions\//);
  });
});

describe("exact AG-UI control", () => {
  it("copies the exact execution identity from AG-UI context", () => {
    expect(agentExecutionIdFromRequest({
      body: JSON.stringify({
        context: [{
          description: "OpenTag execution control",
          value: JSON.stringify({ executionId: "exec-wire" }),
        }],
      }),
    })).toBe("exec-wire");
    expect(agentExecutionIdFromRequest({ body: "{}" })).toBeUndefined();
  });

  it("requires matching accepted and quiescent proof from the service binding", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/opentag/control/interrupt");
      expect(await request.json()).toEqual({ executionId: "exec-1" });
      return Response.json({
        executionId: "exec-1",
        accepted: true,
        quiescent: true,
      });
    });
    await expect(interruptAguiTurn({
      AGENT_URL: "https://agent.example/api/copilotkit/agent/triage/run",
      AGENT_RUNTIME: { fetch } as never,
      AGENT_AUTH_HEADER: "Bearer internal",
    }, "exec-1")).resolves.toEqual({ accepted: true, quiescent: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed on non-quiescent or mismatched control responses", async () => {
    const env = {
      AGENT_URL: "https://agent.example/run",
      AGENT_RUNTIME: {
        fetch: vi.fn(async () => Response.json({
          executionId: "other",
          accepted: true,
          quiescent: false,
        })),
      } as never,
    };
    await expect(interruptAguiTurn(env, "exec-1"))
      .rejects.toThrow("agui_interrupt_not_quiescent");
  });
});
