import Supermemory from "supermemory";

export const SUPERMEMORY_REQUEST_TIMEOUT_MS = 5_000;
const SUPERMEMORY_INTERNAL_ORIGIN = "https://supermemory.internal";

export type SupermemoryClient = Pick<Supermemory, "add" | "documents" | "search">;

/** Minimal shape shared by Cloudflare service bindings and test doubles. */
export type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type SupermemoryClientOptions = {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type SupermemoryEnvironment = {
  SUPERMEMORY?: ServiceBinding;
  SUPERMEMORY_SERVICE_AUTH_TOKEN?: string;
  /** Legacy migration-only endpoint. */
  SUPERMEMORY_URL?: string;
  /** Legacy migration-only credential. */
  SUPERMEMORY_API_KEY?: string;
  /** Explicit opt-in for the retained Railway/read-only migration path. */
  SUPERMEMORY_MIGRATION_MODE?: string;
};

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? SUPERMEMORY_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > 10_000) {
    throw new Error("Supermemory timeout must be between 250 and 10000ms");
  }
  return timeout;
}

/** Construction is inert: the SDK performs no request until a typed adapter call. */
export function createSupermemoryClient(options: SupermemoryClientOptions): SupermemoryClient {
  if (!options.apiKey) throw new Error("SUPERMEMORY_API_KEY is unavailable");
  let url: URL;
  try {
    url = new URL(options.baseURL);
  } catch {
    throw new Error("SUPERMEMORY_URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("SUPERMEMORY_URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("SUPERMEMORY_URL must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return new Supermemory({
    apiKey: options.apiKey,
    baseURL: url.origin,
    timeout: boundedTimeout(options.timeoutMs),
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

function serviceBindingFetch(
  binding: ServiceBinding,
  serviceAuthToken: string,
): typeof fetch {
  return async (input, init) => {
    const source = new Request(input, init);
    const headers = new Headers(source.headers);
    // The SDK's bearer is only a placeholder for the private facade. The
    // facade authenticates the Worker caller with its own shared secret and
    // injects Supermemory's server key inside the Container boundary.
    headers.delete("authorization");
    headers.set("x-opentag-service-token", serviceAuthToken);
    headers.set("x-opentag-client", "opentag-bot");
    const pathname = new URL(source.url).pathname;
    const retryableRead = source.method === "GET" ||
      (source.method === "POST" && (pathname === "/v4/search" || pathname === "/v4/profile"));
    const makeRequest = () => new Request(source.clone(), { headers });
    let response: Response;
    try {
      response = await binding.fetch(makeRequest());
    } catch (error) {
      if (!retryableRead) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return binding.fetch(makeRequest());
    }
    if (retryableRead && response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return binding.fetch(makeRequest());
    }
    return response;
  };
}

/** Construct the private service-binding client, falling back only for the
 * explicitly retained Railway migration path and local compatibility tests. */
export function createSupermemoryClientFromEnv(
  env: SupermemoryEnvironment,
): SupermemoryClient | undefined {
  if (env.SUPERMEMORY) {
    if (!env.SUPERMEMORY_SERVICE_AUTH_TOKEN?.trim()) return undefined;
    return createSupermemoryClient({
      baseURL: SUPERMEMORY_INTERNAL_ORIGIN,
      apiKey: "opentag-service-placeholder",
      fetch: serviceBindingFetch(env.SUPERMEMORY, env.SUPERMEMORY_SERVICE_AUTH_TOKEN),
    });
  }
  if (env.SUPERMEMORY_MIGRATION_MODE?.trim() !== "true") return undefined;
  if (!env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) return undefined;
  return createSupermemoryClient({
    baseURL: env.SUPERMEMORY_URL,
    apiKey: env.SUPERMEMORY_API_KEY,
  });
}

export function supermemoryConfigured(env: SupermemoryEnvironment): boolean {
  return Boolean(
    (env.SUPERMEMORY && env.SUPERMEMORY_SERVICE_AUTH_TOKEN?.trim()) ||
    (env.SUPERMEMORY_MIGRATION_MODE?.trim() === "true" &&
      env.SUPERMEMORY_URL && env.SUPERMEMORY_API_KEY),
  );
}
