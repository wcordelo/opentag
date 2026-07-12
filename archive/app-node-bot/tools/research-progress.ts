/**
 * `research_progress` — posts interim research updates to the thread.
 * Called by the research runtime via client-tool round-trip when configured,
 * or used directly by the delivery poller.
 */
import { z } from "zod";
import { defineBotTool } from "@copilotkit/bot";

export const researchProgressTool = defineBotTool({
  name: "research_progress",
  description:
    "Post an interim progress update to the current thread during deep research.",
  parameters: z.object({
    message: z.string().describe("Progress message to post."),
  }),
  async handler({ message }, { thread }) {
    await thread.post(`🔬 ${message}`);
    return { posted: true };
  },
});
