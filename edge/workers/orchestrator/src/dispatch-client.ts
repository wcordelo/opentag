/**
 * Dispatch client — calls the WASM dispatch Worker via service binding.
 * Falls back to local TS classification if the binding is unavailable.
 */

export interface DispatchResult {
  intent: "research" | "triage" | "question" | "unknown";
  confidence: number;
  extractedObjective: string;
}

export class DispatchClient {
  constructor(private readonly env: { WASM_DISPATCH: Fetcher }) {}

  async classify(
    text: string,
    userId?: string,
    channelId?: string,
  ): Promise<DispatchResult> {
    try {
      const res = await this.env.WASM_DISPATCH.fetch(
        new Request("https://wasm-dispatch/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, userId, channelId }),
        }),
      );
      if (res.ok) {
        return (await res.json()) as DispatchResult;
      }
    } catch (err) {
      console.error("WASM_DISPATCH classify failed; using local fallback", err);
    }
    return localClassify(text);
  }
}

function localClassify(text: string): DispatchResult {
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
