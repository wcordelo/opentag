import type { SessionState, SessionStateData } from "./types.js";

/** Optimistic concurrency: returns false if version_id mismatch. */
export function buildOccUpdate(
  id: string,
  data: SessionStateData,
  expectedVersion: number,
  now: string,
): { id: string; data: SessionStateData; expectedVersion: number; updatedAt: string } {
  return { id, data, expectedVersion, updatedAt: now };
}

export function bumpVersion(session: SessionState, data: SessionStateData, now: string): SessionState {
  return {
    id: session.id,
    data,
    versionId: session.versionId + 1,
    updatedAt: now,
  };
}

export function isOccConflict(rowsAffected: number): boolean {
  return rowsAffected === 0;
}
