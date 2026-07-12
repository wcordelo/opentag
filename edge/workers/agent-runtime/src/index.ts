/**
 * Thin Worker: auth gate + proxy every request to one named triage Container.
 * Public AGENT_URL: https://opentag-agent…/api/copilotkit/agent/triage/run
 */
import { TriageContainer } from "./container.js";
import type { Env } from "./env.js";

export { TriageContainer };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (env.AGENT_AUTH_HEADER) {
      const auth = request.headers.get("Authorization");
      if (auth !== env.AGENT_AUTH_HEADER) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const container = env.TRIAGE.getByName("triage");
    return container.fetch(request);
  },
};
