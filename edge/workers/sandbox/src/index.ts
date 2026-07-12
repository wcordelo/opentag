/**
 * Sandbox Worker — hosts the Cloudflare Sandbox SDK's `Sandbox` Durable
 * Object, which backs each agent (pm/impl/verify) container.
 *
 * The real `Sandbox` DO class ships from `@cloudflare/sandbox` and is
 * re-exported below so wrangler's `durable_objects` binding has a
 * `class_name` to resolve. This worker does not implement container
 * lifecycle logic itself — `ContainerManager.ts` in the orchestrator Worker
 * drives it through the SDK's `getSandbox(env.SANDBOX, sessionId)` factory
 * (injected as `SandboxLike` for testability).
 *
 * Wiring the `[[containers]]` block (Dockerfile image name, instance
 * limits) into wrangler.toml is deferred until an account has the image in
 * `./Dockerfile` built and pushed — see the note in `edge/wrangler.toml`.
 * Until then, `POST /sandbox/start` below returns a mocked handle so local
 * tests / ContainerManager development don't require a real container.
 */
export { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  ENVIRONMENT?: string;
}

interface MockStartRequestBody {
  sessionId?: string;
  flavor?: "pm" | "impl" | "verify";
}

interface MockStartResponse {
  containerId: string;
  previewUrl: string;
  status: "mocked";
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, worker: "opentag-sandbox" });
    }

    // Local-dev / test stub only — never used once the real Sandbox DO +
    // [[containers]] binding is wired up. Lets ContainerManager's start()
    // flow be exercised end-to-end (via HTTP) without provisioning a real
    // container.
    if (url.pathname === "/sandbox/start" && request.method === "POST") {
      let body: MockStartRequestBody = {};
      try {
        body = (await request.json()) as MockStartRequestBody;
      } catch {
        // Empty/invalid body is fine for the mock — sessionId is optional.
      }
      const containerId = crypto.randomUUID();
      const response: MockStartResponse = {
        containerId,
        previewUrl: `https://${containerId}.sandbox.mock.local`,
        status: "mocked",
      };
      return Response.json(response);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
