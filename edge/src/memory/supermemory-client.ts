import Supermemory from "supermemory";

export const SUPERMEMORY_REQUEST_TIMEOUT_MS = 5_000;

export type SupermemoryClient = Pick<Supermemory, "add" | "documents" | "search">;

export type SupermemoryClientOptions = {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
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
