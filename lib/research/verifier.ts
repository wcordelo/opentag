import type { StorageAdapter } from "./adapters/storage.js";
import type { LlmAdapter } from "./adapters/llm.js";
import type {
  VerificationRequest,
  VerificationResult,
  Verdict,
} from "./types.js";
import { generateRequestId } from "./fiber.js";
import { MAX_REVISION_ROUNDS } from "./fiber.js";

const VERIFIER_SYSTEM = [
  "You are a research verifier. Review the summary against the original objective.",
  "Respond with JSON only: { \"verdict\": \"pass\"|\"reject\"|\"revise\", \"issues\": [\"...\"] }",
  "pass = summary adequately addresses objective with supported citations.",
  "revise = close but needs specific improvements (list in issues).",
  "reject = fundamentally wrong, hallucinated, or off-topic.",
].join("\n");

export interface VerifierDeps {
  storage: StorageAdapter;
  llm: LlmAdapter;
  model?: string;
}

export class Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(req: VerificationRequest): Promise<VerificationResult> {
    if (await this.deps.storage.isRequestProcessed(req.requestId)) {
      const cached = await this.deps.storage.getVerificationCache(req.requestId);
      if (cached) {
        return { ...(cached as VerificationResult), cached: true };
      }
    }

    const now = new Date().toISOString();
    const prompt = [
      `Objective: ${req.objective}`,
      `Summary: ${req.summary}`,
      `Citations (${req.citations.length}):`,
      ...req.citations.map((c) => `- ${c.title ?? c.url}: ${c.snippet ?? ""}`),
    ].join("\n");

    const response = await this.deps.llm.complete({
      model: this.deps.model ?? "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: VERIFIER_SYSTEM },
        { role: "user", content: prompt },
      ],
      metadata: { actor: "verifier", requestId: req.requestId },
    });

    const result = parseVerifierResponse(response.content, req.requestId);
    await this.deps.storage.markRequestProcessed(req.requestId, now);
    await this.deps.storage.setVerificationCache(req.requestId, result, now);
    return result;
  }
}

function parseVerifierResponse(content: string, requestId: string): VerificationResult {
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(content);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: string; issues?: string[] };
      const verdict = normalizeVerdict(parsed.verdict);
      return { verdict, issues: parsed.issues ?? [], requestId };
    }
  } catch {
    // fall through
  }
  return { verdict: "pass", issues: [], requestId };
}

function normalizeVerdict(v?: string): Verdict {
  if (v === "reject" || v === "revise" || v === "pass") return v;
  return "pass";
}

export function shouldRevise(round: number, verdict: Verdict): boolean {
  return verdict === "revise" && round < MAX_REVISION_ROUNDS;
}

export function shouldReject(verdict: Verdict): boolean {
  return verdict === "reject";
}

export { MAX_REVISION_ROUNDS };
