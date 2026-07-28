/** Expand retrieved wiki/code hits with neighboring context. */

const DEFAULT_RADIUS = 1;

/**
 * Join wiki sections around `hitIndex` within `radius` (default 1).
 * Out-of-range indices are clamped; empty input yields "".
 */
export function expandWikiNeighbors(
  sections: string[],
  hitIndex: number,
  radius: number = DEFAULT_RADIUS,
): string {
  if (!Array.isArray(sections) || sections.length === 0) return "";
  if (!Number.isFinite(hitIndex) || !Number.isFinite(radius) || radius < 0) {
    throw new Error("hitIndex and radius must be finite; radius must be >= 0");
  }
  const start = Math.max(0, Math.floor(hitIndex) - Math.floor(radius));
  const end = Math.min(sections.length - 1, Math.floor(hitIndex) + Math.floor(radius));
  return sections.slice(start, end + 1).join("\n\n");
}

/**
 * Expand a code line window `[start, end]` (inclusive, 0-based) by `radius`
 * lines on each side (default 1).
 */
export function expandCodeWindow(
  lines: string[],
  start: number,
  end: number,
  radius: number = DEFAULT_RADIUS,
): string {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(radius) ||
    radius < 0
  ) {
    throw new Error("start, end, and radius must be finite; radius must be >= 0");
  }
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const from = Math.max(0, Math.floor(lo) - Math.floor(radius));
  const to = Math.min(lines.length - 1, Math.floor(hi) + Math.floor(radius));
  return lines.slice(from, to + 1).join("\n");
}
