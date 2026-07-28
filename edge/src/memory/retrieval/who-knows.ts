/**
 * Stub Cerebras-style people/PR tools (K2 Phase 5).
 * Return structured empty/partial results until Slack authorship + GitHub
 * connectors supply evidence; never invent experts or PRs.
 */

export type WhoKnowsHit = {
  userId: string;
  displayName?: string;
  evidenceCount: number;
  sourceKeys: string[];
};

export type RecentPrHit = {
  repoId: string;
  number: number;
  title: string;
  url?: string;
  updatedAt: string;
};

/**
 * Derive candidate experts from citation authorship metadata when present.
 * Without `rootAuthorId` / author metadata, returns [].
 */
export function whoKnowsFromEvidence(input: {
  query: string;
  evidence: Array<{ sourceKey: string; metadata?: Record<string, unknown> }>;
}): WhoKnowsHit[] {
  const counts = new Map<string, { evidenceCount: number; sourceKeys: string[] }>();
  for (const row of input.evidence) {
    const author =
      typeof row.metadata?.rootAuthorId === "string"
        ? row.metadata.rootAuthorId
        : typeof row.metadata?.authorId === "string"
          ? row.metadata.authorId
          : undefined;
    if (!author) continue;
    const current = counts.get(author) ?? { evidenceCount: 0, sourceKeys: [] };
    current.evidenceCount += 1;
    if (current.sourceKeys.length < 10) current.sourceKeys.push(row.sourceKey);
    counts.set(author, current);
  }
  return [...counts.entries()]
    .map(([userId, value]) => ({ userId, ...value }))
    .sort((a, b) => b.evidenceCount - a.evidenceCount);
}

/** Placeholder until GitHub connector emits recent_prs evidence rows. */
export function recentPrsFromEvidence(input: {
  evidence: Array<{ sourceKey: string; metadata?: Record<string, unknown> }>;
}): RecentPrHit[] {
  const hits: RecentPrHit[] = [];
  for (const row of input.evidence) {
    const meta = row.metadata ?? {};
    if (meta.sourceType !== "code" && meta.kind !== "pull_request") continue;
    const number = typeof meta.prNumber === "number" ? meta.prNumber : undefined;
    const title = typeof meta.prTitle === "string" ? meta.prTitle : undefined;
    const repoId = typeof meta.repoId === "string" ? meta.repoId : undefined;
    const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : undefined;
    if (!number || !title || !repoId || !updatedAt) continue;
    hits.push({
      repoId,
      number,
      title,
      updatedAt,
      ...(typeof meta.prUrl === "string" ? { url: meta.prUrl } : {}),
    });
  }
  return hits;
}
