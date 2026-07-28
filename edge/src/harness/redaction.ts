/**
 * Structured redaction for harness-derived strings before durable persistence,
 * callbacks, diagnostics, or Slack delivery.
 *
 * Authoritative boundary: `edge/src/harness/client.ts` must sanitize every
 * event payload before `appendEvent` / accumulation / `onText`.
 */

export const REDACTION_MARKER = "[REDACTED]";
export const MAX_REDACTION_DEPTH = 16;
export const MAX_REDACTION_NODES = 10_000;

export type RedactionRuleCategory =
  | "bearer"
  | "slack_token"
  | "anthropic_key"
  | "openai_key"
  | "github_token"
  | "sandbox_token"
  | "env_assignment"
  | "exact_secret";

export type SanitizeFailureReason =
  | "depth_exceeded"
  | "node_limit_exceeded"
  | "unsupported_value";

export type SanitizeResult =
  | { ok: true; value: unknown; replacementCount: number; categories: RedactionRuleCategory[] }
  | { ok: false; reason: SanitizeFailureReason; replacementCount: number; categories: RedactionRuleCategory[] };

export type RedactionTelemetry = {
  ruleCategory: RedactionRuleCategory;
  eventKind: string;
  replacementCount: number;
  sanitizerFailureCount: number;
  executionId: string;
};

const BEARER_RE =
  /\b(?:Authorization\s*:\s*)?(?:Bearer|bearer)\s+[A-Za-z0-9\-._~+/]+=*/g;
const SLACK_TOKEN_RE = /\bxox[a-zA-Z]-[A-Za-z0-9-]{10,}/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{16,}/g;
/** OpenAI-style sk-* with ≥16 secret characters after the prefix; avoids short words. */
const OPENAI_KEY_RE = /\bsk-(?!ant-)[A-Za-z0-9]{16,}/g;
const GITHUB_TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;
const SANDBOX_TOKEN_RE = /\bsbx1\.[A-Za-z0-9._-]{8,}/g;
const ENV_ASSIGNMENT_RE =
  /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|COOKIE|AUTH|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/g;

const RULES: Array<{ category: RedactionRuleCategory; pattern: RegExp }> = [
  { category: "bearer", pattern: BEARER_RE },
  { category: "slack_token", pattern: SLACK_TOKEN_RE },
  { category: "anthropic_key", pattern: ANTHROPIC_KEY_RE },
  { category: "openai_key", pattern: OPENAI_KEY_RE },
  { category: "github_token", pattern: GITHUB_TOKEN_RE },
  { category: "sandbox_token", pattern: SANDBOX_TOKEN_RE },
  { category: "env_assignment", pattern: ENV_ASSIGNMENT_RE },
];

export function redactString(
  input: string,
  exactSecrets: readonly string[] = [],
): { text: string; replacementCount: number; categories: RedactionRuleCategory[] } {
  let text = input;
  let replacementCount = 0;
  const categories = new Set<RedactionRuleCategory>();

  for (const secret of exactSecrets) {
    if (!secret || secret.length < 8) continue;
    if (!text.includes(secret)) continue;
    text = text.split(secret).join(REDACTION_MARKER);
    replacementCount += 1;
    categories.add("exact_secret");
  }

  for (const { category, pattern } of RULES) {
    pattern.lastIndex = 0;
    const next = text.replace(pattern, () => {
      replacementCount += 1;
      categories.add(category);
      return REDACTION_MARKER;
    });
    text = next;
  }

  return { text, replacementCount, categories: [...categories] };
}

export function sanitizeValue(
  value: unknown,
  opts: {
    exactSecrets?: readonly string[];
    maxDepth?: number;
    maxNodes?: number;
  } = {},
): SanitizeResult {
  const exactSecrets = opts.exactSecrets ?? [];
  const maxDepth = opts.maxDepth ?? MAX_REDACTION_DEPTH;
  const maxNodes = opts.maxNodes ?? MAX_REDACTION_NODES;
  let replacementCount = 0;
  const categories = new Set<RedactionRuleCategory>();
  let nodes = 0;

  const walk = (current: unknown, depth: number): unknown => {
    if (depth > maxDepth) {
      throw Object.assign(new Error("depth_exceeded"), {
        reason: "depth_exceeded" as const,
      });
    }
    nodes += 1;
    if (nodes > maxNodes) {
      throw Object.assign(new Error("node_limit_exceeded"), {
        reason: "node_limit_exceeded" as const,
      });
    }

    if (typeof current === "string") {
      const redacted = redactString(current, exactSecrets);
      replacementCount += redacted.replacementCount;
      for (const c of redacted.categories) categories.add(c);
      return redacted.text;
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (Array.isArray(current)) {
      return current.map((item) => walk(item, depth + 1));
    }
    if (typeof current === "object") {
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) {
        throw Object.assign(new Error("unsupported_value"), {
          reason: "unsupported_value" as const,
        });
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        out[key] = walk(child, depth + 1);
      }
      return out;
    }
    throw Object.assign(new Error("unsupported_value"), {
      reason: "unsupported_value" as const,
    });
  };

  try {
    const sanitized = walk(value, 0);
    return {
      ok: true,
      value: sanitized,
      replacementCount,
      categories: [...categories],
    };
  } catch (err) {
    const reason =
      err && typeof err === "object" && "reason" in err
        ? (err as { reason: SanitizeFailureReason }).reason
        : "unsupported_value";
    return {
      ok: false,
      reason,
      replacementCount,
      categories: [...categories],
    };
  }
}

/** Safe malformed-NDJSON diagnostic: never log the raw prefix. */
export async function malformedNdjsonDigest(
  line: string,
): Promise<{ byteLength: number; sha256: string; reason: "malformed_ndjson" }> {
  const bytes = new TextEncoder().encode(line);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { byteLength: bytes.byteLength, sha256, reason: "malformed_ndjson" };
}

export function emitRedactionTelemetry(entry: RedactionTelemetry): void {
  console.info(
    JSON.stringify({
      type: "harness_redaction",
      ruleCategory: entry.ruleCategory,
      eventKind: entry.eventKind,
      replacementCount: entry.replacementCount,
      sanitizerFailureCount: entry.sanitizerFailureCount,
      executionId: entry.executionId,
    }),
  );
}

export function collectExactSecretsFromEnv(
  env: Record<string, unknown> | undefined,
): string[] {
  if (!env) return [];
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "HARNESS_AUTH_TOKEN",
    "GITHUB_TOKEN",
    "LINEAR_API_KEY",
    "ADMIN_SECRET",
  ];
  const out: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.length >= 8) out.push(value);
  }
  return out;
}
