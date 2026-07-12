import type { LlmRequest, LlmResponse } from "../types.js";

export interface LlmAdapter {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmAdapterConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultModel?: string;
  fallbackModel?: string;
  aiGatewayUrl?: string;
  aiGatewayAccountId?: string;
  aiGatewayId?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const FALLBACK_MODEL = "gpt-4o";

export class DirectLlmAdapter implements LlmAdapter {
  private errorCounts = new Map<string, number>();
  private circuitOpenUntil = new Map<string, number>();
  private readonly circuitThreshold = 3;
  private readonly circuitResetMs = 60_000;

  constructor(private readonly config: LlmAdapterConfig) {}

  getActiveModel(hint?: string): string {
    const preferred =
      hint ??
      this.config.defaultModel ??
      (this.config.anthropicApiKey?.trim() ? DEFAULT_MODEL : FALLBACK_MODEL);
    if (this.isCircuitOpen(preferred) && this.config.fallbackModel) {
      return this.config.fallbackModel;
    }
    if (this.isCircuitOpen(preferred)) {
      return FALLBACK_MODEL;
    }
    return preferred;
  }

  private isCircuitOpen(model: string): boolean {
    const until = this.circuitOpenUntil.get(model);
    if (!until) return false;
    if (Date.now() > until) {
      this.circuitOpenUntil.delete(model);
      this.errorCounts.delete(model);
      return false;
    }
    return true;
  }

  private recordError(model: string): void {
    const count = (this.errorCounts.get(model) ?? 0) + 1;
    this.errorCounts.set(model, count);
    if (count >= this.circuitThreshold) {
      this.circuitOpenUntil.set(model, Date.now() + this.circuitResetMs);
    }
  }

  private recordSuccess(model: string): void {
    this.errorCounts.delete(model);
    this.circuitOpenUntil.delete(model);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model;
    const isAnthropic = model.startsWith("claude") || model.includes("anthropic");

    try {
      const response = isAnthropic
        ? await this.callAnthropic(request)
        : await this.callOpenAI(request);
      this.recordSuccess(model);
      return response;
    } catch (err) {
      this.recordError(model);
      throw err;
    }
  }

  private async callAnthropic(request: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    const url = this.buildGatewayUrl("anthropic") ??
      "https://api.anthropic.com/v1/messages";

    const body = {
      model: request.model.replace(/^anthropic\//, ""),
      max_tokens: 4096,
      messages: request.messages.filter((m) => m.role !== "system"),
      system: request.messages.find((m) => m.role === "system")?.content,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (request.metadata) {
      headers["cf-aig-metadata"] = JSON.stringify(request.metadata);
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const content = json.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("");

    return {
      content,
      model: json.model,
      usage: json.usage
        ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
        : undefined,
    };
  }

  private async callOpenAI(request: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const url = this.buildGatewayUrl("openai") ??
      "https://api.openai.com/v1/chat/completions";

    const body = {
      model: request.model.replace(/^openai\//, ""),
      messages: request.messages,
      max_tokens: 4096,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (request.metadata) {
      headers["cf-aig-metadata"] = JSON.stringify(request.metadata);
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: json.choices[0]?.message.content ?? "",
      model: json.model,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined,
    };
  }

  private buildGatewayUrl(provider: string): string | null {
    const { aiGatewayUrl, aiGatewayAccountId, aiGatewayId } = this.config;
    if (aiGatewayUrl) return `${aiGatewayUrl}/${provider}/v1/messages`;
    if (aiGatewayAccountId && aiGatewayId) {
      return `https://gateway.ai.cloudflare.com/v1/${aiGatewayAccountId}/${aiGatewayId}/${provider}/v1/messages`;
    }
    return null;
  }
}

/** Redact sensitive headers for research_log storage. */
export function redactForLog(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactForLog);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (/authorization|api[_-]?key|secret|token/i.test(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object") {
      result[key] = redactForLog(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
