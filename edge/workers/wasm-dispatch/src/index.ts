/**
 * WASM Dispatch Worker — intent classifier.
 *
 * Track D eventual target: syumai/workers-compiled TinyGo WASM becomes this
 * Worker's fetch handler. Until TinyGo is installed in CI/dev, this TypeScript
 * implementation mirrors the Go dispatch contract from Task 5.2 so Tracks A/B
 * can integrate via the WASM_DISPATCH service binding today.
 *
 * Go source of truth: edge/wasm-core/main.go
 */
export interface DispatchRequest {
  text: string;
  userId?: string;
  channelId?: string;
}

export interface DispatchResponse {
  intent: "research" | "triage" | "question" | "unknown";
  confidence: number;
  extractedObjective: string;
}

export function classify(text: string): DispatchResponse {
  const trimmed = text.trim();
  const extractedObjective = trimmed
    .replace(/<@[^>]+>/g, "")
    .replace(/^\s*research[:\s]+/i, "")
    .trim();

  if (/^\s*research\b/i.test(trimmed) || /\bresearch:\s*/i.test(trimmed)) {
    return { intent: "research", confidence: 1.0, extractedObjective };
  }
  if (/\btriage\b/i.test(trimmed) || /\/triage/i.test(trimmed)) {
    return { intent: "triage", confidence: 1.0, extractedObjective };
  }
  if (trimmed.endsWith("?")) {
    return { intent: "question", confidence: 0.8, extractedObjective };
  }
  return { intent: "unknown", confidence: 0.5, extractedObjective };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        ok: true,
        worker: "opentag-wasm-dispatch",
        impl: "typescript-fallback",
      });
    }

    if (url.pathname === "/dispatch" && request.method === "POST") {
      let body: DispatchRequest;
      try {
        body = (await request.json()) as DispatchRequest;
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      if (typeof body.text !== "string") {
        return Response.json({ error: "text_required" }, { status: 400 });
      }
      return Response.json(classify(body.text));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
