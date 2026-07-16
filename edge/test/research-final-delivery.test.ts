import { describe, expect, it, vi } from "vitest";
import { deliverResearchSlackObligation } from "../workers/orchestrator/src/OrchestratorDO.js";

describe("OrchestratorDO final research delivery", () => {
  it("passes final task identity to the production Slack card delivery", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const, duplicate: false }));
    await expect(deliverResearchSlackObligation({
      id: "obligation-7",
      threadKey: "slack:C1:1.0",
      payload: { type: "final", text: "synthesis", taskId: "research-42" },
    }, "xoxb", deliver)).resolves.toEqual({ status: "delivered", duplicate: false });
    expect(deliver).toHaveBeenCalledWith(
      "slack:C1:1.0",
      "synthesis",
      "obligation-7",
      "xoxb",
      { type: "final", text: "synthesis", taskId: "research-42" },
    );
  });
});
