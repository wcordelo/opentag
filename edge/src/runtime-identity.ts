export type RuntimeEngine = "agui" | "claudecode" | "claudex" | "nanocodex";

export type RuntimeEvidenceSource =
  | "deployment"
  | "health"
  | "configuration"
  | "unconfirmed";

export type RuntimeEvidenceStatus =
  | "live"
  | "configured"
  | "stale"
  | "invalid"
  | "unconfirmed";

export type RuntimeDeploymentEvidence = Readonly<{
  source: RuntimeEvidenceSource;
  environment?: string;
  release?: string;
  provider?: string;
  capabilities?: readonly string[];
  observedAt?: string;
  nowMs?: number;
  maxAgeMs?: number;
}>;

export type RuntimeEvidenceProjection = Readonly<{
  source: RuntimeEvidenceSource;
  status: RuntimeEvidenceStatus;
  environment?: string;
  release?: string;
  provider?: string;
  capabilities: readonly string[];
  observedAt?: string;
}>;

const DEFAULT_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_EVIDENCE_FIELD_LENGTH = 96;
const MAX_CAPABILITIES = 12;
const SENSITIVE_VALUE_RE =
  /(?:authorization|bearer|cookie|credential|password|private[_ -]?key|secret|token|api[_ -]?key)/i;

function boundedValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EVIDENCE_FIELD_LENGTH);
  if (!normalized || SENSITIVE_VALUE_RE.test(normalized)) return undefined;
  return normalized;
}

function boundedCapability(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > MAX_EVIDENCE_FIELD_LENGTH ||
    SENSITIVE_VALUE_RE.test(normalized) ||
    !/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function boundedCapabilities(values: readonly string[] | undefined): readonly string[] {
  if (!values) return [];
  return [...new Set(values.map(boundedCapability).filter((value): value is string => Boolean(value)))]
    .slice(0, MAX_CAPABILITIES);
}

export function projectRuntimeEvidence(
  evidence?: RuntimeDeploymentEvidence,
): RuntimeEvidenceProjection {
  if (!evidence) {
    return { source: "unconfirmed", status: "unconfirmed", capabilities: [] };
  }

  const source = evidence.source;
  const facts = {
    source,
    environment: boundedValue(evidence.environment),
    release: boundedValue(evidence.release),
    provider: boundedValue(evidence.provider),
    capabilities: boundedCapabilities(evidence.capabilities),
  } satisfies Omit<RuntimeEvidenceProjection, "status" | "observedAt">;

  if (source === "configuration") {
    return { ...facts, status: "configured" };
  }
  if (source === "unconfirmed") {
    return { ...facts, status: "unconfirmed" };
  }

  const observedAt = boundedValue(evidence.observedAt);
  if (!observedAt) return { ...facts, status: "unconfirmed" };
  const observedMs = Date.parse(observedAt);
  const nowMs = evidence.nowMs ?? Date.now();
  const maxAgeMs = evidence.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    observedMs > nowMs
  ) {
    return { ...facts, status: "invalid", observedAt };
  }
  if (nowMs - observedMs > maxAgeMs) {
    return { ...facts, status: "stale", observedAt };
  }
  return { ...facts, status: "live", observedAt };
}

function formatEvidenceLine(evidence: RuntimeEvidenceProjection): string {
  const details: string[] = [`source: ${evidence.source}`];
  if (evidence.environment) details.push(`environment: ${evidence.environment}`);
  if (evidence.release) details.push(`release: ${evidence.release}`);
  if (evidence.provider) details.push(`provider: ${evidence.provider}`);
  if (evidence.observedAt) details.push(`observedAt: ${evidence.observedAt}`);
  return `- Runtime evidence: ${evidence.status} (${details.join("; ")}).`;
}

export function formatRuntimeIdentity(args: {
  engine: RuntimeEngine;
  model?: string;
  modelSource?: string;
  harnessConnected: boolean;
  deployment?: RuntimeDeploymentEvidence;
}): string {
  const engineLabel =
    args.engine === "agui"
      ? "AG-UI triage runtime (not a coding harness)"
      : args.engine === "claudex"
        ? "Claude Code harness via Claudex"
        : args.engine === "nanocodex"
          ? "Nanocodex coding harness"
          : "Claude Code harness";
  const model = boundedValue(args.model);
  const modelSource = boundedValue(args.modelSource);
  const modelLine = model
    ? `- Model: ${model}${
        modelSource ? ` (source: ${modelSource})` : ""
      }.`
    : "- Model: not confirmed on this edge turn (agent-runtime may still apply AGENT_MODEL).";
  const evidence = projectRuntimeEvidence(args.deployment);
  const capabilityLine = evidence.capabilities.length > 0
    ? `- Reported runtime capabilities: ${evidence.capabilities.join(", ")}.`
    : "- Reported runtime capabilities: none confirmed by the supplied evidence.";
  return [
    "OpenTag runtime identity (authoritative for this turn):",
    "- Product: OpenTag on Cloudflare Workers / Containers.",
    `- Engine this turn: ${engineLabel}.`,
    modelLine,
    `- Coding harness connected: ${args.harnessConnected ? "yes" : "no"}.`,
    formatEvidenceLine(evidence),
    capabilityLine,
    "- Repository-local instructions and source files are not live deployment evidence.",
    "- To use a coding harness, the user can pass --claude, --claudex, or --nanocodex (sticky per thread), or ask a repository coding task when the harness is connected.",
    '- Do not invent a third product called an "OpenTag Slack bot harness". OpenTag is the product; AG-UI, Claude Code, and Nanocodex are engines.',
    "- Call show_permissions for the exact redacted tools/access snapshot for this turn. Its output is informational, not authorization.",
  ].join("\n");
}
