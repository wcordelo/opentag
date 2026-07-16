import type { SqlExecutor, TransactionRunner } from "./sql.js";

export const SESSION_HANDOFF_MAX_ATTEMPTS = 3;
export const SESSION_HANDOFF_RETRY_MS = 2_000;
export const SESSION_HANDOFF_TTL_MS = 24 * 60 * 60_000;
export const SESSION_HANDOFF_CLAIM_TIMEOUT_MS = 30_000;

export type SessionHandoffStatus =
  | "pending"
  | "claimed"
  | "accepted"
  | "duplicate"
  | "cancelled"
  | "exhausted";

export interface SessionHandoffRow {
  threadKey: string;
  executionId: string;
  forwardedMessageId: string;
  inputLines: string[];
  status: SessionHandoffStatus;
  dueAt: number;
  attempt: number;
  claimToken?: string;
  result?: string;
  expiresAt: number;
}

type DbRow = {
  thread_key: string;
  execution_id: string;
  forwarded_message_id: string;
  input_lines: string;
  status: SessionHandoffStatus;
  due_at: number;
  attempt: number;
  claim_token: string | null;
  result: string | null;
  expires_at: number;
};

const COLUMNS = `thread_key, execution_id, forwarded_message_id, input_lines,
  status, due_at, attempt, claim_token, result, expires_at`;

function mapRow(row: DbRow): SessionHandoffRow {
  return {
    threadKey: row.thread_key,
    executionId: row.execution_id,
    forwardedMessageId: row.forwarded_message_id,
    inputLines: JSON.parse(row.input_lines) as string[],
    status: row.status,
    dueAt: row.due_at,
    attempt: row.attempt,
    claimToken: row.claim_token ?? undefined,
    result: row.result ?? undefined,
    expiresAt: row.expires_at,
  };
}

export class SessionHandoffEngine {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly tx: TransactionRunner,
    private readonly now: () => number = () => Date.now(),
    private readonly newToken: () => string = () => crypto.randomUUID(),
  ) {}

  start(args: {
    threadKey: string;
    executionId: string;
    forwardedMessageId: string;
    inputLines: string[];
    delayMs?: number;
  }): SessionHandoffRow {
    return this.tx(() => {
      const existing = this.get(args.threadKey);
      if (existing) {
        if (
          existing.executionId !== args.executionId ||
          existing.forwardedMessageId !== args.forwardedMessageId
        ) throw new Error("session_handoff_identity_conflict");
        return existing;
      }
      const now = this.now();
      this.sql.exec(
        `INSERT INTO session_handoffs (${COLUMNS})
         VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, ?)`,
        args.threadKey,
        args.executionId,
        args.forwardedMessageId,
        JSON.stringify(args.inputLines),
        now + (args.delayMs ?? 0),
        now + SESSION_HANDOFF_TTL_MS,
      );
      return this.get(args.threadKey)!;
    });
  }

  get(threadKey: string): SessionHandoffRow | undefined {
    this.sql.exec(`DELETE FROM session_handoffs WHERE expires_at <= ?`, this.now());
    const row = this.sql.exec<DbRow>(
      `SELECT ${COLUMNS} FROM session_handoffs WHERE thread_key = ?`,
      threadKey,
    ).toArray()[0];
    return row ? mapRow(row) : undefined;
  }

  claimDue(now = this.now()): SessionHandoffRow | undefined {
    return this.tx(() => {
      // A crashed claimant becomes retryable without inventing a new identity.
      this.sql.exec(
        `UPDATE session_handoffs SET status = 'pending', claim_token = NULL, claimed_at = NULL
         WHERE status = 'claimed' AND claimed_at <= ?`,
        now - SESSION_HANDOFF_CLAIM_TIMEOUT_MS,
      );
      const row = this.sql.exec<DbRow>(
        `SELECT ${COLUMNS} FROM session_handoffs
         WHERE status = 'pending' AND due_at <= ? AND expires_at > ?
         ORDER BY due_at ASC, thread_key ASC LIMIT 1`,
        now,
        now,
      ).toArray()[0];
      if (!row) return undefined;
      const token = this.newToken();
      this.sql.exec(
        `UPDATE session_handoffs
         SET status = 'claimed', claim_token = ?, claimed_at = ?, attempt = attempt + 1
         WHERE thread_key = ? AND execution_id = ? AND status = 'pending'`,
        token,
        now,
        row.thread_key,
        row.execution_id,
      );
      return this.get(row.thread_key);
    });
  }

  complete(args: {
    threadKey: string;
    executionId: string;
    claimToken: string;
    outcome: "accepted" | "duplicate" | "cancelled";
  }): boolean {
    return this.tx(() => {
      this.sql.exec(
        `UPDATE session_handoffs SET status = ?, claim_token = NULL, claimed_at = NULL,
           result = ?, expires_at = ?
         WHERE thread_key = ? AND execution_id = ? AND status = 'claimed' AND claim_token = ?`,
        args.outcome,
        args.outcome,
        this.now() + SESSION_HANDOFF_TTL_MS,
        args.threadKey,
        args.executionId,
        args.claimToken,
      );
      return this.changed();
    });
  }

  retry(args: {
    threadKey: string;
    executionId: string;
    claimToken: string;
    reason: string;
    delayMs?: number;
  }): "pending" | "exhausted" | "stale" {
    return this.tx(() => {
      const row = this.get(args.threadKey);
      if (
        !row || row.executionId !== args.executionId ||
        row.status !== "claimed" || row.claimToken !== args.claimToken
      ) return "stale";
      const exhausted = row.attempt >= SESSION_HANDOFF_MAX_ATTEMPTS;
      this.sql.exec(
        `UPDATE session_handoffs SET status = ?, claim_token = NULL, claimed_at = NULL,
           result = ?, due_at = ?, expires_at = ?
         WHERE thread_key = ? AND execution_id = ? AND claim_token = ?`,
        exhausted ? "exhausted" : "pending",
        args.reason,
        this.now() + (args.delayMs ?? SESSION_HANDOFF_RETRY_MS),
        this.now() + SESSION_HANDOFF_TTL_MS,
        args.threadKey,
        args.executionId,
        args.claimToken,
      );
      return exhausted ? "exhausted" : "pending";
    });
  }

  clear(threadKey: string, executionId: string): boolean {
    return this.tx(() => {
      this.sql.exec(
        `DELETE FROM session_handoffs WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      return this.changed();
    });
  }

  earliestDue(): number | undefined {
    const row = this.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at FROM session_handoffs WHERE status = 'pending'`,
    ).one();
    return row.due_at ?? undefined;
  }

  private changed(): boolean {
    return this.sql.exec<{ n: number }>(`SELECT changes() AS n`).one().n > 0;
  }
}
