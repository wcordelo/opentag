import type { Env } from "./env.js";
import type { RuntimeReadinessProfile } from "./runtime-readiness.js";

export type RuntimeDependencyProbes = Readonly<{
  agentReachable: boolean;
  knowledgeSearchReachable?: boolean;
  codeGraphReachable?: boolean;
  harnessReachable?: boolean;
  credentialBrokerReachable?: boolean;
  platformEffecterReachable?: boolean;
}>;

type ProbeEnv = Partial<Pick<
  Env,
  | "AGENT_RUNTIME"
  | "AGENT_URL"
  | "SUPERMEMORY"
  | "SUPERMEMORY_SERVICE_AUTH_TOKEN"
  | "GRAPHIFY"
  | "GRAPHIFY_SERVICE_AUTH_TOKEN"
  | "HARNESS"
  | "HARNESS_URL"
  | "CONNECTOR_CREDENTIALS"
  | "PLATFORM_EFFECTER"
>>;

const PROBE_TIMEOUT_MS = 1_500;
const CONTAINER_PROBE_TIMEOUT_MS = 30_000;
type ProbeValidator = (response: Response) => Promise<boolean> | boolean;

async function probeRequest(
  request: (signal: AbortSignal) => Promise<Response>,
  validate: ProbeValidator = (response) => response.ok,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      request(controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
    return response instanceof Response && await validate(response);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function healthUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function bindingProbe(
  binding: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | undefined,
  origin: string,
  headers?: HeadersInit,
  validate?: ProbeValidator,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!binding) return Promise.resolve(false);
  return probeRequest((signal) => binding.fetch(new Request(`${origin}/health`, {
    headers,
    signal,
  })), validate, timeoutMs);
}

function urlProbe(url: string | undefined): Promise<boolean> {
  const target = url ? healthUrl(url) : undefined;
  return target ? probeRequest((signal) => fetch(target, { signal })) : Promise.resolve(false);
}

async function jsonFieldProbe(
  response: Response,
  field: string,
): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = await response.json() as Record<string, unknown>;
    return body.ok === true && body[field] === true;
  } catch {
    return false;
  }
}

async function jsonStatusProbe(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = await response.json() as Record<string, unknown>;
    return body.status === "ok";
  } catch {
    return false;
  }
}

export async function probeRuntimeDependencies(
  env: ProbeEnv,
  profile: RuntimeReadinessProfile,
): Promise<RuntimeDependencyProbes> {
  const probes: {
    agentReachable: boolean;
    knowledgeSearchReachable?: boolean;
    codeGraphReachable?: boolean;
    harnessReachable?: boolean;
    credentialBrokerReachable?: boolean;
    platformEffecterReachable?: boolean;
  } = {
    agentReachable: env.AGENT_RUNTIME
      ? await bindingProbe(env.AGENT_RUNTIME, "https://agent")
      : await urlProbe(env.AGENT_URL),
  };
  if (profile === "core") return probes;

  probes.knowledgeSearchReachable = env.SUPERMEMORY && env.SUPERMEMORY_SERVICE_AUTH_TOKEN?.trim()
    ? await bindingProbe(env.SUPERMEMORY, "https://supermemory", {
      "x-opentag-service-token": env.SUPERMEMORY_SERVICE_AUTH_TOKEN,
    }, jsonStatusProbe, CONTAINER_PROBE_TIMEOUT_MS)
    : false;
  probes.codeGraphReachable = env.GRAPHIFY && env.GRAPHIFY_SERVICE_AUTH_TOKEN?.trim()
    ? await bindingProbe(env.GRAPHIFY, "https://graphify", {
      "x-opentag-graphify-token": env.GRAPHIFY_SERVICE_AUTH_TOKEN,
    }, jsonStatusProbe, CONTAINER_PROBE_TIMEOUT_MS)
    : false;
  if (profile === "knowledge") return probes;

  probes.harnessReachable = env.HARNESS
    ? await bindingProbe(env.HARNESS, "https://harness", undefined, async (response) => {
      if (!response.ok) return false;
      try {
        const body = await response.json() as Record<string, unknown>;
        return body.ok === true;
      } catch {
        return false;
      }
    }, CONTAINER_PROBE_TIMEOUT_MS)
    : await urlProbe(env.HARNESS_URL);
  probes.credentialBrokerReachable = await bindingProbe(
    env.CONNECTOR_CREDENTIALS,
    "https://credential-broker",
    undefined,
    (response) => jsonFieldProbe(response, "providerResolutionEnabled"),
  );
  probes.platformEffecterReachable = await bindingProbe(
    env.PLATFORM_EFFECTER,
    "https://platform-effecter",
    undefined,
    (response) => jsonFieldProbe(response, "providerEffectsEnabled"),
  );
  return probes;
}
