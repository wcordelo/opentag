/**
 * Defense-in-depth redaction inside the harness Container.
 * Authoritative sanitization remains `edge/src/harness/redaction.ts` on the Worker.
 */

export const REDACTION_MARKER = "[REDACTED]";

const BEARER_RE =
  /\b(?:Authorization\s*:\s*)?(?:Bearer|bearer)\s+[A-Za-z0-9\-._~+/]+=*/g;
const SLACK_TOKEN_RE = /\bxox[a-zA-Z]-[A-Za-z0-9-]{10,}/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{16,}/g;
const OPENAI_KEY_RE = /\bsk-(?!ant-)[A-Za-z0-9]{16,}/g;
const GITHUB_TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;
const SANDBOX_TOKEN_RE = /\bsbx1\.[A-Za-z0-9._-]{8,}/g;
const ENV_ASSIGNMENT_RE =
  /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|COOKIE|AUTH|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/g;

const RULES: RegExp[] = [
  BEARER_RE,
  SLACK_TOKEN_RE,
  ANTHROPIC_KEY_RE,
  OPENAI_KEY_RE,
  GITHUB_TOKEN_RE,
  SANDBOX_TOKEN_RE,
  ENV_ASSIGNMENT_RE,
];

export function redactOutputString(input: string): string {
  let text = input;
  for (const pattern of RULES) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, REDACTION_MARKER);
  }
  return text;
}

export function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return REDACTION_MARKER;
  if (typeof value === "string") return redactOutputString(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactJsonValue(child, depth + 1);
    }
    return out;
  }
  return value;
}
