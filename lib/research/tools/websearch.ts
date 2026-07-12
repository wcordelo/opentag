/** Web search via Parallel API (or mock when no key). */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  query: string;
  maxResults?: number;
}

const PARALLEL_API_URL = "https://api.parallel.ai/v1beta/search";

export async function webSearch(
  options: WebSearchOptions,
  apiKey?: string,
): Promise<SearchResult[]> {
  const key = apiKey ?? process.env["PARALLEL_API_KEY"];
  if (!key) {
    return mockSearch(options.query);
  }

  const res = await fetch(PARALLEL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({
      objective: options.query,
      max_results: options.maxResults ?? 5,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Parallel search failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; excerpt?: string; content?: string }>;
  };

  return (json.results ?? []).map((r) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.excerpt ?? r.content?.slice(0, 300) ?? "",
  }));
}

/** Mock search for tests / no API key. */
function mockSearch(query: string): SearchResult[] {
  return [
    {
      title: `Result for: ${query}`,
      url: `https://example.com/search?q=${encodeURIComponent(query)}`,
      snippet: `Mock search result for "${query}". Set PARALLEL_API_KEY for live results.`,
    },
  ];
}

export interface ExternalJobHandle {
  provider: string;
  jobId: string;
  status: "pending" | "running" | "complete" | "failed";
  result?: string;
}

export async function pollExternalJob(
  handle: { provider: string; jobId: string },
  apiKey?: string,
): Promise<ExternalJobHandle> {
  const key = apiKey ?? process.env["PARALLEL_API_KEY"];
  if (!key || handle.provider !== "parallel") {
    return { ...handle, status: "complete", result: "Mock deep research complete." };
  }

  const res = await fetch(`https://api.parallel.ai/v1beta/tasks/${handle.jobId}`, {
    headers: { "x-api-key": key },
  });

  if (!res.ok) {
    return { ...handle, status: "failed" };
  }

  const json = (await res.json()) as {
    status?: string;
    output?: { content?: string };
  };

  const status = json.status === "completed" ? "complete"
    : json.status === "failed" ? "failed"
    : "running";

  return {
    ...handle,
    status,
    result: json.output?.content,
  };
}

export async function startDeepResearch(
  objective: string,
  apiKey?: string,
): Promise<ExternalJobHandle> {
  const key = apiKey ?? process.env["PARALLEL_API_KEY"];
  if (!key) {
    return { provider: "mock", jobId: `mock_${Date.now()}`, status: "complete", result: `Mock deep research on: ${objective}` };
  }

  const res = await fetch("https://api.parallel.ai/v1beta/tasks/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({
      input: { objective },
      processor: "ultra",
    }),
  });

  if (!res.ok) {
    throw new Error(`Parallel deep research start failed: ${res.status}`);
  }

  const json = (await res.json()) as { run_id?: string; id?: string };
  return {
    provider: "parallel",
    jobId: json.run_id ?? json.id ?? `unknown_${Date.now()}`,
    status: "pending",
  };
}
