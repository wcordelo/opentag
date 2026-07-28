/** Optional LLM distillation of a Slack thread into a structured artifact. */

export type SlackDistillArtifact = {
  question: string;
  summary: string;
  resolution: string;
  systems: string[];
  code_refs: string[];
};

export type DistillLlm = (prompt: string) => Promise<string>; // returns JSON string

export type SlackDistillOk = {
  status: "ok";
  artifact: SlackDistillArtifact;
  embedText: string;
};

export type SlackDistillSkipped = {
  status: "skipped";
  reason: string;
  embedText: string;
};

export type SlackDistillResult = SlackDistillOk | SlackDistillSkipped;

const DEFAULT_TIMEOUT_MS = 15_000;

export function buildSlackDistillPrompt(transcript: string): string {
  return [
    "Distill the following Slack thread into a single JSON object with exactly these fields:",
    '- "question": string — the core question or problem being discussed',
    '- "summary": string — concise summary of the discussion',
    '- "resolution": string — the outcome or resolution (empty string if unresolved)',
    '- "systems": string[] — systems, services, or products mentioned',
    '- "code_refs": string[] — file paths, symbols, PRs, or code references mentioned',
    "Return ONLY valid JSON. No markdown fences or commentary.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export function embedTextFromArtifact(artifact: SlackDistillArtifact): string {
  const systems = artifact.systems.filter(Boolean).join(", ");
  const codeRefs = artifact.code_refs.filter(Boolean).join(", ");
  return [
    artifact.question,
    artifact.summary,
    artifact.resolution,
    systems,
    codeRefs,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string`);
    return item;
  });
}

export function parseSlackDistillArtifact(raw: string): SlackDistillArtifact {
  const trimmed = raw.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    : trimmed;
  const parsed: unknown = JSON.parse(unfenced);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("distill artifact must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  return {
    question: asString(obj.question, "question"),
    summary: asString(obj.summary, "summary"),
    resolution: asString(obj.resolution, "resolution"),
    systems: asStringArray(obj.systems, "systems"),
    code_refs: asStringArray(obj.code_refs, "code_refs"),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Distill a Slack transcript via LLM. On timeout or parse failure, fail closed
 * to the raw transcript as embedText (`status: "skipped"`).
 */
export async function distillSlackThread(input: {
  transcript: string;
  llm: DistillLlm;
  timeoutMs?: number;
}): Promise<SlackDistillResult> {
  const transcript = input.transcript ?? "";
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const raw = await withTimeout(
      input.llm(buildSlackDistillPrompt(transcript)),
      timeoutMs,
      "slack distill",
    );
    const artifact = parseSlackDistillArtifact(raw);
    return {
      status: "ok",
      artifact,
      embedText: embedTextFromArtifact(artifact),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "distill failed";
    return {
      status: "skipped",
      reason,
      embedText: transcript,
    };
  }
}
