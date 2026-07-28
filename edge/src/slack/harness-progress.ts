/**
 * Slack renderer for provider-neutral harness progress events.
 * One stable progress message per execution; final answer stays separate.
 */

export type ProgressItem = {
  progressId: string;
  sequence: number;
  category: "commentary" | "task" | "tool";
  state: "started" | "updated" | "completed" | "failed";
  title: string;
  summary?: string;
};

export type HarnessContextLine = {
  harnessType: string;
  model?: string;
  modelEvidence: "requested" | "container_argument" | "provider_reported" | "unknown";
};

const MAX_VISIBLE = 8;
const TITLE_MAX = 120;
const SUMMARY_MAX = 500;

export function formatContextLine(ctx: HarnessContextLine): string {
  const harnessLabel =
    ctx.harnessType === "claudex"
      ? "Claude Code (Claudex)"
      : ctx.harnessType === "claudecode"
        ? "Claude Code"
        : ctx.harnessType;
  if (!ctx.model || ctx.modelEvidence === "unknown") {
    return `_${harnessLabel} · model unconfirmed_`;
  }
  const evidence =
    ctx.modelEvidence === "provider_reported"
      ? "provider confirmed"
      : ctx.modelEvidence === "container_argument"
        ? "container argument"
        : "requested";
  return `_${harnessLabel} · ${ctx.model} · ${evidence}_`;
}

export function clampProgressItem(item: ProgressItem): ProgressItem {
  return {
    ...item,
    title: item.title.slice(0, TITLE_MAX),
    ...(item.summary !== undefined
      ? { summary: item.summary.slice(0, SUMMARY_MAX) }
      : {}),
  };
}

/**
 * Fold a new progress event into the per-execution map.
 * Duplicate (progressId, sequence) is a no-op; completed/failed are terminal.
 */
export function applyProgressEvent(
  items: Map<string, ProgressItem>,
  raw: ProgressItem,
): { changed: boolean; items: Map<string, ProgressItem> } {
  const next = new Map(items);
  let event = clampProgressItem(raw);
  const existing = next.get(event.progressId);
  if (existing) {
    if (
      existing.sequence === event.sequence &&
      existing.state === event.state &&
      existing.title === event.title &&
      existing.summary === event.summary
    ) {
      return { changed: false, items };
    }
    if (existing.state === "completed" || existing.state === "failed") {
      return { changed: false, items };
    }
    if (event.sequence < existing.sequence) {
      return { changed: false, items };
    }
    // Completion/failure from tool_result may not know the tool display name.
    if (
      (event.state === "completed" || event.state === "failed") &&
      (event.title === "Tool" || event.title === existing.title)
    ) {
      event = {
        ...event,
        title: existing.title,
        ...(event.summary === undefined && existing.summary !== undefined
          ? { summary: existing.summary }
          : {}),
      };
    }
  }
  next.set(event.progressId, event);
  return { changed: true, items: next };
}

export function renderProgressMarkdown(
  items: Iterable<ProgressItem>,
  opts: { done?: boolean; failed?: boolean } = {},
): string {
  // Preserve caller/Map insertion order (first-seen chronological). Per-item
  // `sequence` is only a lifecycle counter within one progressId (start→done),
  // not a global timeline — do not sort by progressId or that sequence.
  const list = [...items];
  const completed = list.filter(
    (i) => i.state === "completed" || i.state === "failed",
  );
  const active = list.filter(
    (i) => i.state === "started" || i.state === "updated",
  );
  const visible = [...active, ...completed].slice(-MAX_VISIBLE);
  const earlier = Math.max(0, list.length - visible.length);
  const lines: string[] = ["*Coding progress*"];
  if (earlier > 0) lines.push(`_${earlier} earlier item(s)_`);
  for (const item of visible) {
    const mark =
      item.state === "completed"
        ? "✓"
        : item.state === "failed"
          ? "✗"
          : "•";
    const summary = item.summary ? ` — ${item.summary}` : "";
    lines.push(`${mark} *${item.title}*${summary}`);
  }
  if (opts.failed) lines.push("_Interrupted or failed_");
  else if (opts.done) lines.push("_Complete_");
  return lines.join("\n");
}

/** Rebuild progress state solely from durable context/progress events. */
export function rebuildProgressFromEvents(
  events: Array<{ kind: string; payload: unknown }>,
): {
  context?: HarnessContextLine;
  items: Map<string, ProgressItem>;
} {
  let context: HarnessContextLine | undefined;
  const items = new Map<string, ProgressItem>();
  const evidenceRank: Record<HarnessContextLine["modelEvidence"], number> = {
    unknown: 0,
    requested: 1,
    container_argument: 2,
    provider_reported: 3,
  };
  for (const event of events) {
    if (event.kind === "context" && event.payload && typeof event.payload === "object") {
      const p = event.payload as Record<string, unknown>;
      const next: HarnessContextLine = {
        harnessType: typeof p.harnessType === "string" ? p.harnessType : "claudecode",
        model: typeof p.model === "string" ? p.model : undefined,
        modelEvidence:
          p.modelEvidence === "requested" ||
          p.modelEvidence === "container_argument" ||
          p.modelEvidence === "provider_reported" ||
          p.modelEvidence === "unknown"
            ? p.modelEvidence
            : "unknown",
      };
      // Match SessionEventDO: only upgrade on strictly higher evidence.
      if (
        !context ||
        evidenceRank[next.modelEvidence] > evidenceRank[context.modelEvidence]
      ) {
        context = next;
      }
    }
    if (event.kind === "progress" && event.payload && typeof event.payload === "object") {
      const p = event.payload as Record<string, unknown>;
      if (
        typeof p.progressId !== "string" ||
        typeof p.sequence !== "number" ||
        typeof p.title !== "string"
      ) {
        continue;
      }
      const category =
        p.category === "commentary" || p.category === "task" || p.category === "tool"
          ? p.category
          : "task";
      const state =
        p.state === "started" ||
        p.state === "updated" ||
        p.state === "completed" ||
        p.state === "failed"
          ? p.state
          : "updated";
      const applied = applyProgressEvent(items, {
        progressId: p.progressId,
        sequence: p.sequence,
        category,
        state,
        title: p.title,
        ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
      });
      items.clear();
      for (const [k, v] of applied.items) items.set(k, v);
    }
  }
  return { context, items };
}
