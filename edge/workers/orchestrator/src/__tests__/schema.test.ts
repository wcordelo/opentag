/**
 * Schema migration unit tests — verifies MIGRATION 001+002 apply idempotently
 * against a recording SqlExecutor (no Miniflare required).
 */
import { describe, expect, it } from "vitest";
import { runMigrations, type SqlLike } from "../schema";

class RecordingSql implements SqlLike {
  statements: string[] = [];
  versions = new Set<number>();

  exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[]; rowsWritten: number } {
    const normalized = query.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);

    if (/SELECT 1 FROM schema_migrations WHERE version = \?/i.test(normalized)) {
      const version = Number(bindings[0]);
      return {
        toArray: () => (this.versions.has(version) ? [1] : []),
        rowsWritten: 0,
      };
    }

    if (/INSERT INTO schema_migrations/i.test(normalized)) {
      this.versions.add(Number(bindings[0]));
      return { toArray: () => [], rowsWritten: 1 };
    }

    return { toArray: () => [], rowsWritten: 0 };
  }
}

describe("runMigrations", () => {
  it("applies version 1 and 2 on a fresh database", () => {
    const sql = new RecordingSql();
    runMigrations(sql);
    expect(sql.versions.has(1)).toBe(true);
    expect(sql.versions.has(2)).toBe(true);
    expect(sql.statements.some((s) => /CREATE TABLE IF NOT EXISTS tasks/i.test(s))).toBe(true);
    expect(
      sql.statements.some((s) => /CREATE TABLE IF NOT EXISTS agent_containers/i.test(s)),
    ).toBe(true);
  });

  it("is idempotent on a second run", () => {
    const sql = new RecordingSql();
    runMigrations(sql);
    const afterFirst = sql.statements.length;
    runMigrations(sql);
    // Second run should only re-ensure schema_migrations exists + two version checks
    expect(sql.statements.length - afterFirst).toBeLessThan(10);
    expect(sql.versions.size).toBe(2);
  });
});
