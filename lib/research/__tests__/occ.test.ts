import { describe, it, expect } from "vitest";
import { isOccConflict, bumpVersion } from "../occ.js";
import type { SessionState, SessionStateData } from "../types.js";

describe("OCC", () => {
  it("detects conflict when rows affected is 0", () => {
    expect(isOccConflict(0)).toBe(true);
    expect(isOccConflict(1)).toBe(false);
  });

  it("bumps version", () => {
    const session: SessionState = {
      id: "s1",
      data: { status: "running", objective: "test", fiberIndex: 0 },
      versionId: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const data: SessionStateData = { ...session.data, fiberIndex: 1 };
    const bumped = bumpVersion(session, data, "2026-01-02T00:00:00Z");
    expect(bumped.versionId).toBe(2);
    expect(bumped.data.fiberIndex).toBe(1);
  });
});
