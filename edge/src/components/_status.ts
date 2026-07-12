/** Shared status/priority → glyph mapping for Linear cards. */

export function stateGlyph(state?: string): string {
  const s = (state ?? "").toLowerCase();
  if (s.includes("done") || s.includes("complete")) return "✅";
  if (s.includes("progress") || s.includes("started")) return "🔵";
  if (s.includes("review")) return "🟣";
  if (s.includes("cancel")) return "🚫";
  if (s.includes("backlog")) return "⚪";
  return "🟠";
}

export function priorityGlyph(priority?: string): string {
  const p = (priority ?? "").toLowerCase();
  if (p.includes("urgent")) return "🚨";
  if (p.includes("high")) return "🔴";
  if (p.includes("medium")) return "🟠";
  if (p.includes("low")) return "⚪";
  return "";
}

export const ACCENT = {
  linear: "#5E6AD2",
  notion: "#2F3437",
  urgent: "#EB5757",
  high: "#F2994A",
  done: "#27AE60",
  progress: "#2D9CDB",
  canceled: "#9B9B9B",
} as const;

export function accentForIssue(issue: {
  state?: string;
  priority?: string;
}): string {
  const p = (issue.priority ?? "").toLowerCase();
  if (p.includes("urgent")) return ACCENT.urgent;
  if (p.includes("high")) return ACCENT.high;
  const s = (issue.state ?? "").toLowerCase();
  if (s.includes("done") || s.includes("complete")) return ACCENT.done;
  if (s.includes("cancel")) return ACCENT.canceled;
  if (s.includes("progress") || s.includes("started")) return ACCENT.progress;
  return ACCENT.linear;
}

export function accentForIssues(
  issues: ReadonlyArray<{ priority?: string }>,
): string {
  const prios = issues.map((i) => (i.priority ?? "").toLowerCase());
  if (prios.some((p) => p.includes("urgent"))) return ACCENT.urgent;
  if (prios.some((p) => p.includes("high"))) return ACCENT.high;
  return ACCENT.linear;
}
