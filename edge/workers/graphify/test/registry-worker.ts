import { env } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { GraphifyRegistryDO } from "../src/registry-do.js";

type RegistryTestEnv = {
  REGISTRY: DurableObjectNamespace<GraphifyRegistryDO>;
};

export { GraphifyRegistryDO };

export default {
  async fetch(request: Request, bindings: RegistryTestEnv = env as RegistryTestEnv): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") || "registry-test";
    return bindings.REGISTRY.getByName(name).fetch(request);
  },
};
