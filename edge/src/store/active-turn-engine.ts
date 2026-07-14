import type { SqlExecutor, TransactionRunner } from "./sql.js";
import {
  STOP_CONTINUATION_TTL_MS,
  type ActiveTurnCancellationResult,
  type ActiveTurnEffectResource,
  type ActiveTurnRecord,
  type ActiveTurnEffectClaim,
  type ActiveTurnRenderClaim,
  type ActiveTurnSnapshot,
  type ActiveTurnDeliveryStatus,
} from "./active-turn-types.js";

type Row = {
  thread_key: string;
  channel_id: string;
  conversation_key: string;
  execution_id: string;
  thread_ts: string | null;
  choice_id: string | null;
  registered_at: number;
  delivery_status: ActiveTurnDeliveryStatus;
  render_token: string | null;
  effect_token: string | null;
  effect_name: string | null;
  effect_resource: string | null;
  confirmed_output: number;
  stop_event_id: string | null;
  updated_at: number;
  expires_at: number;
};

type ChoiceRow = { choice_id: string };

const HITL_CHOICE_TTL_MS = 10 * 60_000;

function hitlChoiceKey(choiceId: string): string {
  return `hitl-id:${choiceId}`;
}

function hitlCancelledKey(choiceId: string): string {
  return `hitl-cancelled:${choiceId}`;
}

const COLUMNS = `thread_key, channel_id, conversation_key, execution_id,
  thread_ts, choice_id, registered_at, delivery_status, render_token,
  effect_token, effect_name, effect_resource, confirmed_output, stop_event_id, updated_at, expires_at`;

export class ActiveTurnEngine {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly tx: TransactionRunner,
    private readonly now: () => number = () => Date.now(),
    private readonly newToken: () => string = () => crypto.randomUUID(),
  ) {}

  register(
    record: ActiveTurnRecord,
    ttlMs: number,
    obligation?: {
      afterEventId: number;
      channel: string;
      threadTs?: string;
      timeoutMs: number;
    },
  ): {
    accepted: boolean;
    duplicate: boolean;
  } {
    return this.tx(() => {
      this.deleteExpired(record.threadKey);
      const current = this.row(record.threadKey);
      if (current) {
        return {
          accepted: false,
          duplicate: current.execution_id === record.executionId,
        };
      }
      const now = this.now();
      this.sql.exec(
        `DELETE FROM active_turn_choices WHERE thread_key = ?`,
        record.threadKey,
      );
      this.sql.exec(
        `INSERT INTO active_turns (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
        record.threadKey,
        record.channelId,
        record.conversationKey,
        record.executionId,
        record.threadTs ?? null,
        record.choiceId ?? null,
        record.registeredAt,
        now,
        now + ttlMs,
      );
      if (obligation) {
        this.sql.exec(
          `INSERT INTO render_obligations
             (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
           VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(thread_key) DO UPDATE SET
             execution_id = excluded.execution_id,
             after_event_id = excluded.after_event_id,
             channel = excluded.channel,
             thread_ts = excluded.thread_ts,
             deadline = excluded.deadline,
             attempt = 0`,
          record.threadKey,
          record.executionId,
          obligation.afterEventId,
          obligation.channel,
          obligation.threadTs ?? null,
          now + obligation.timeoutMs,
        );
      }
      return { accepted: true, duplicate: false };
    });
  }

  refresh(record: ActiveTurnRecord, ttlMs: number): boolean {
    return this.tx(() => {
      this.deleteExpired(record.threadKey);
      const now = this.now();
      this.sql.exec(
        `UPDATE active_turns SET expires_at = ?, updated_at = ?
         WHERE thread_key = ? AND execution_id = ?`,
        now + ttlMs,
        now,
        record.threadKey,
        record.executionId,
      );
      return this.changed();
    });
  }

  get(threadKey: string): ActiveTurnSnapshot | undefined {
    this.deleteExpired(threadKey);
    return this.snapshot(this.row(threadKey));
  }

  latest(channelId: string): ActiveTurnSnapshot | undefined {
    const now = this.now();
    this.sql.exec(
      `DELETE FROM active_turn_choices
       WHERE EXISTS (
         SELECT 1 FROM active_turns
         WHERE active_turns.thread_key = active_turn_choices.thread_key
           AND active_turns.execution_id = active_turn_choices.execution_id
           AND active_turns.expires_at <= ?
       )`,
      now,
    );
    this.sql.exec(`DELETE FROM active_turns WHERE expires_at <= ?`, now);
    return this.snapshot(
      this.sql.exec<Row>(
        `SELECT ${COLUMNS} FROM active_turns
         WHERE channel_id = ?
         ORDER BY registered_at DESC, execution_id DESC LIMIT 1`,
        channelId,
      ).toArray()[0],
    );
  }

  registerChoice(
    threadKey: string,
    executionId: string,
    choiceId: string,
  ): "registered" | "cancelled" | "missing" {
    return this.tx(() => {
      this.deleteExpired(threadKey);
      const row = this.row(threadKey);
      if (!row || row.execution_id !== executionId) return "missing";
      if (
        row.delivery_status !== "pending" ||
        row.render_token !== null ||
        row.stop_event_id !== null
      ) {
        return row.delivery_status === "delivered" ? "missing" : "cancelled";
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO active_turn_choices
           (thread_key, execution_id, choice_id, registered_at)
         VALUES (?, ?, ?, ?)`,
        threadKey,
        executionId,
        choiceId,
        this.now(),
      );
      return "registered";
    });
  }

  unregisterChoice(
    threadKey: string,
    executionId: string,
    choiceId: string,
  ): boolean {
    return this.tx(() => {
      this.sql.exec(
        `DELETE FROM active_turn_choices
         WHERE thread_key = ? AND execution_id = ? AND choice_id = ?`,
        threadKey,
        executionId,
        choiceId,
      );
      return this.changed();
    });
  }

  /**
   * Publish Stop denials for every exact picker owned by this execution.
   * The active status predicate, registry scan, receipts, tombstones, and
   * registry cleanup share one SQLite transaction, so a concurrent dynamic
   * registration either appears in this scan or observes cancellation.
   */
  cancelRegisteredChoices(
    threadKey: string,
    executionId: string,
  ): string[] {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (
        !row ||
        row.execution_id !== executionId ||
        ![
          "cancelled",
          "cancel_controlled",
          "cancel_ack_in_flight",
          "cancel_confirmed",
        ].includes(row.delivery_status)
      ) {
        throw new Error("active_turn_not_cancelled");
      }
      const now = this.now();
      const expiresAt = now + HITL_CHOICE_TTL_MS;
      const choices = this.sql
        .exec<ChoiceRow>(
          `SELECT choice_id FROM active_turn_choices
           WHERE thread_key = ? AND execution_id = ?
           ORDER BY registered_at ASC, choice_id ASC`,
          threadKey,
          executionId,
        )
        .toArray();
      for (const { choice_id: choiceId } of choices) {
        const denial = JSON.stringify({
          value: { confirmed: false, choiceId },
          at: now,
        });
        this.sql.exec(
          `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, expires_at = excluded.expires_at`,
          hitlChoiceKey(choiceId),
          denial,
          expiresAt,
        );
        this.sql.exec(
          `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, expires_at = excluded.expires_at`,
          hitlCancelledKey(choiceId),
          "true",
          expiresAt,
        );
      }
      this.sql.exec(
        `DELETE FROM active_turn_choices
         WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      return choices.map((choice) => choice.choice_id);
    });
  }

  claimCancellation(
    threadKey: string,
    executionId: string,
    stopEventId: string,
  ): ActiveTurnCancellationResult {
    return this.tx(() => {
      this.deleteExpired(threadKey);
      const row = this.row(threadKey);
      if (!row || row.execution_id !== executionId) return "missing";
      if (row.delivery_status === "delivered") return "committed";
      if (row.delivery_status === "cancel_confirmed") return "committed";
      if (row.render_token) {
        // Preserve the intent even though an already-dispatched Slack request
        // cannot be truthfully cancelled. A non-final prep/status render will
        // then fence every later launch; a final render remains the commit
        // winner and leaves Stop silent.
        this.sql.exec(
          `UPDATE active_turns SET stop_event_id = COALESCE(stop_event_id, ?),
             updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ?
             AND delivery_status = 'pending' AND render_token IS NOT NULL`,
          stopEventId,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
        );
        return "in_flight";
      }
      if (row.effect_token) {
        // Remember the first Stop while the mutation's result is unresolved.
        // Completion atomically converts this pending intent to cancellation,
        // so the run loop cannot squeeze another tool into the poll window.
        this.sql.exec(
          `UPDATE active_turns SET stop_event_id = COALESCE(stop_event_id, ?),
             updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ?
             AND delivery_status = 'pending' AND effect_token IS NOT NULL`,
          stopEventId,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
        );
        return "effect_in_flight";
      }
      if (row.delivery_status === "pending") {
        this.sql.exec(
          `UPDATE active_turns
           SET delivery_status = 'cancelled', stop_event_id = ?, updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ? AND delivery_status = 'pending'
             AND render_token IS NULL AND effect_token IS NULL`,
          stopEventId,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
        );
        return this.changed() ? "claimed" : "in_flight";
      }
      if (row.stop_event_id === stopEventId) {
        this.sql.exec(
          `UPDATE active_turns SET updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ? AND stop_event_id = ?`,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
          stopEventId,
        );
        return row.delivery_status === "cancel_ack_in_flight"
          ? "ack_retry"
          : "retry";
      }
      if (
        row.delivery_status === "cancelled" ||
        row.delivery_status === "cancel_controlled"
      ) {
        // A distinct explicit Stop may adopt only a retryable failed-control
        // state. It never steals an acknowledgement already in flight.
        this.sql.exec(
          `UPDATE active_turns
           SET delivery_status = 'cancelled', stop_event_id = ?, updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ?
             AND delivery_status IN ('cancelled', 'cancel_controlled')`,
          stopEventId,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
        );
        return this.changed() ? "claimed" : "in_flight";
      }
      return "committed";
    });
  }

  markCancelControlled(
    threadKey: string,
    executionId: string,
    stopEventId: string,
  ): boolean {
    return this.transitionStop(
      threadKey,
      executionId,
      stopEventId,
      ["cancelled", "cancel_controlled"],
      "cancel_controlled",
    );
  }

  beginCancelAck(
    threadKey: string,
    executionId: string,
    stopEventId: string,
  ): boolean {
    return this.tx(() => {
      this.sql.exec(
        `UPDATE active_turns SET delivery_status = 'cancel_ack_in_flight', updated_at = ?, expires_at = ?
         WHERE thread_key = ? AND execution_id = ? AND stop_event_id = ?
           AND delivery_status = 'cancel_controlled'`,
        this.now(),
        this.now() + STOP_CONTINUATION_TTL_MS,
        threadKey,
        executionId,
        stopEventId,
      );
      return this.changed();
    });
  }

  failCancelAck(
    threadKey: string,
    executionId: string,
    stopEventId: string,
  ): boolean {
    return this.transitionStop(
      threadKey,
      executionId,
      stopEventId,
      ["cancel_ack_in_flight"],
      "cancel_controlled",
    );
  }

  confirmCancellationAndClear(
    threadKey: string,
    executionId: string,
    stopEventId: string,
  ): boolean {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (
        !row ||
        row.execution_id !== executionId ||
        row.stop_event_id !== stopEventId ||
        row.delivery_status !== "cancel_ack_in_flight"
      ) return false;
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turn_choices WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turns WHERE thread_key = ? AND execution_id = ?
           AND stop_event_id = ? AND delivery_status = 'cancel_ack_in_flight'`,
        threadKey,
        executionId,
        stopEventId,
      );
      return this.changed();
    });
  }

  /** Stops whose side effect has resolved and now need durable control/ack. */
  pendingStopContinuations(): ActiveTurnSnapshot[] {
    return this.tx(() => {
      const now = this.now();
      this.sql.exec(`DELETE FROM active_turns WHERE expires_at <= ?`, now);
      // Refresh ownership before crossing any external control/Slack boundary.
      // The alarm runs well inside this bounded lease, so an ordinary active-
      // turn expiry can never erase already-claimed Stop work mid-retry.
      this.sql.exec(
        `UPDATE active_turns SET expires_at = ?
         WHERE stop_event_id IS NOT NULL
           AND effect_token IS NULL
           AND render_token IS NULL
           AND delivery_status IN ('cancelled', 'cancel_controlled', 'cancel_ack_in_flight')`,
        now + STOP_CONTINUATION_TTL_MS,
      );
      return this.sql.exec<Row>(
        `SELECT ${COLUMNS} FROM active_turns
         WHERE stop_event_id IS NOT NULL
           AND effect_token IS NULL
           AND render_token IS NULL
           AND delivery_status IN ('cancelled', 'cancel_controlled', 'cancel_ack_in_flight')
         ORDER BY updated_at ASC`,
      ).toArray().map((row) => this.snapshot(row)!);
    });
  }

  beginRender(threadKey: string, executionId: string): ActiveTurnRenderClaim {
    return this.tx(() => {
      this.deleteExpired(threadKey);
      const row = this.row(threadKey);
      if (!row || row.execution_id !== executionId) return { status: "missing" };
      if (row.stop_event_id) return { status: "cancelled" };
      if (
        row.delivery_status === "cancelled" ||
        row.delivery_status === "cancel_controlled" ||
        row.delivery_status === "cancel_ack_in_flight" ||
        row.delivery_status === "cancel_confirmed"
      ) return { status: "cancelled" };
      if (row.delivery_status === "delivered") return { status: "committed" };
      // A shortcut/tool mutation may still be in flight or have an ambiguous
      // outcome. Recovery must not render and terminally delete the turn until
      // that effect becomes definitive.
      if (row.effect_token) return { status: "in_flight" };
      if (row.render_token) return { status: "in_flight" };
      const token = this.newToken();
      this.sql.exec(
        `UPDATE active_turns SET render_token = ?, updated_at = ?
         WHERE thread_key = ? AND execution_id = ?
           AND delivery_status = 'pending' AND render_token IS NULL
           AND effect_token IS NULL`,
        token,
        this.now(),
        threadKey,
        executionId,
      );
      return this.changed() ? { status: "claimed", token } : { status: "in_flight" };
    });
  }

  confirmRender(
    threadKey: string,
    executionId: string,
    token: string,
    final: boolean,
    output: boolean,
  ): boolean {
    return this.tx(() => {
      if (final) {
        const row = this.row(threadKey);
        if (
          !row ||
          row.execution_id !== executionId ||
          row.render_token !== token ||
          row.delivery_status !== "pending"
        ) return false;
        this.sql.exec(
          `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
          threadKey,
          executionId,
        );
        this.sql.exec(
          `DELETE FROM active_turn_choices WHERE thread_key = ? AND execution_id = ?`,
          threadKey,
          executionId,
        );
        this.sql.exec(
          `DELETE FROM active_turns WHERE thread_key = ? AND execution_id = ?
             AND render_token = ? AND delivery_status = 'pending'`,
          threadKey,
          executionId,
          token,
        );
        return this.changed();
      }
      this.sql.exec(
        `UPDATE active_turns
         SET render_token = NULL,
             confirmed_output = CASE WHEN ? THEN 1 ELSE confirmed_output END,
             delivery_status = CASE
               WHEN stop_event_id IS NOT NULL THEN 'cancelled'
               ELSE delivery_status
             END,
             expires_at = CASE
               WHEN stop_event_id IS NOT NULL THEN ?
               ELSE expires_at
             END,
             updated_at = ?
         WHERE thread_key = ? AND execution_id = ? AND render_token = ?
           AND delivery_status = 'pending'`,
        output ? 1 : 0,
        this.now() + STOP_CONTINUATION_TTL_MS,
        this.now(),
        threadKey,
        executionId,
        token,
      );
      return this.changed();
    });
  }

  /** Re-open only after a definitive application-level rejection. */
  failRender(threadKey: string, executionId: string, token: string): boolean {
    return this.tx(() => {
      this.sql.exec(
        `UPDATE active_turns SET render_token = NULL,
           delivery_status = CASE
             WHEN stop_event_id IS NOT NULL THEN 'cancelled'
             ELSE delivery_status
           END,
           expires_at = CASE
             WHEN stop_event_id IS NOT NULL THEN ?
             ELSE expires_at
           END,
           updated_at = ?
         WHERE thread_key = ? AND execution_id = ? AND render_token = ?
           AND delivery_status = 'pending'`,
        this.now() + STOP_CONTINUATION_TTL_MS,
        this.now(),
        threadKey,
        executionId,
        token,
      );
      return this.changed();
    });
  }

  /**
   * Claim a non-Slack production side effect before crossing its RPC boundary.
   * A retained token means the remote outcome is ambiguous; Stop must remain
   * silent because that mutation could still land after the request throws.
   */
  beginEffect(
    threadKey: string,
    executionId: string,
    effectName: string,
  ): ActiveTurnEffectClaim {
    return this.tx(() => {
      this.deleteExpired(threadKey);
      const row = this.row(threadKey);
      if (!row || row.execution_id !== executionId) return { status: "missing" };
      if (row.stop_event_id) return { status: "cancelled" };
      if (
        row.delivery_status === "cancelled" ||
        row.delivery_status === "cancel_controlled" ||
        row.delivery_status === "cancel_ack_in_flight" ||
        row.delivery_status === "cancel_confirmed"
      ) return { status: "cancelled" };
      if (row.delivery_status === "delivered") return { status: "committed" };
      if (row.effect_token || row.render_token) return { status: "in_flight" };
      const token = this.newToken();
      this.sql.exec(
        `UPDATE active_turns SET effect_token = ?, effect_name = ?, updated_at = ?
         WHERE thread_key = ? AND execution_id = ?
           AND delivery_status = 'pending' AND render_token IS NULL
           AND effect_token IS NULL AND stop_event_id IS NULL`,
        token,
        effectName,
        this.now(),
        threadKey,
        executionId,
      );
      return this.changed() ? { status: "claimed", token } : { status: "in_flight" };
    });
  }

  /** Clear only after a definitive remote success. */
  confirmEffect(
    threadKey: string,
    executionId: string,
    token: string,
    resource?: ActiveTurnEffectResource,
  ): boolean {
    return this.clearEffect(threadKey, executionId, token, resource);
  }

  /** Clear only after a definitive application-level failure. */
  failEffect(threadKey: string, executionId: string, token: string): boolean {
    return this.clearEffect(threadKey, executionId, token);
  }

  lifecycleComplete(threadKey: string, executionId: string): boolean {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (
        !row ||
        row.execution_id !== executionId ||
        row.delivery_status !== "pending" ||
        row.render_token !== null ||
        row.effect_token !== null ||
        row.confirmed_output !== 1
      ) return false;
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turn_choices WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turns WHERE thread_key = ? AND execution_id = ?
           AND delivery_status = 'pending' AND render_token IS NULL
           AND effect_token IS NULL
           AND confirmed_output = 1`,
        threadKey,
        executionId,
      );
      return this.changed();
    });
  }

  /**
   * Abandon ingress ownership only while it is provably pristine. This is not
   * a normal completion path: any rendered output, claimed effect, Stop, or
   * terminal transition makes the CAS fail and preserves recovery state.
   */
  abandonPristine(threadKey: string, executionId: string): boolean {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (
        !row ||
        row.execution_id !== executionId ||
        row.delivery_status !== "pending" ||
        row.render_token !== null ||
        row.effect_token !== null ||
        row.stop_event_id !== null ||
        row.confirmed_output !== 0
      ) return false;
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turn_choices WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turns WHERE thread_key = ? AND execution_id = ?
           AND delivery_status = 'pending' AND render_token IS NULL
           AND effect_token IS NULL AND stop_event_id IS NULL
           AND confirmed_output = 0`,
        threadKey,
        executionId,
      );
      return this.changed();
    });
  }

  /**
   * Remove a freshly re-registered exact execution that SessionEventDO proved
   * was already cancelled by an earlier, visibly-confirmed Stop. A concurrent
   * new Stop wins by moving the row away from pristine `pending`, so this CAS
   * cannot erase a failed control attempt or its obligation.
   */
  discardInterruptedRedelivery(threadKey: string, executionId: string): boolean {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (
        !row ||
        row.execution_id !== executionId ||
        row.delivery_status !== "pending" ||
        row.render_token !== null ||
        row.effect_token !== null ||
        row.stop_event_id !== null
      ) return false;
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turn_choices WHERE thread_key = ? AND execution_id = ?`,
        threadKey,
        executionId,
      );
      this.sql.exec(
        `DELETE FROM active_turns WHERE thread_key = ? AND execution_id = ?
           AND delivery_status = 'pending' AND render_token IS NULL
           AND effect_token IS NULL AND stop_event_id IS NULL`,
        threadKey,
        executionId,
      );
      return this.changed();
    });
  }

  private transitionStop(
    threadKey: string,
    executionId: string,
    stopEventId: string,
    from: ActiveTurnDeliveryStatus[],
    to: ActiveTurnDeliveryStatus,
  ): boolean {
    return this.tx(() => {
      const row = this.row(threadKey);
      if (!row || row.execution_id !== executionId || row.stop_event_id !== stopEventId) {
        return false;
      }
      if (row.delivery_status === to) {
        this.sql.exec(
          `UPDATE active_turns SET updated_at = ?, expires_at = ?
           WHERE thread_key = ? AND execution_id = ? AND stop_event_id = ?`,
          this.now(),
          this.now() + STOP_CONTINUATION_TTL_MS,
          threadKey,
          executionId,
          stopEventId,
        );
        return true;
      }
      if (!from.includes(row.delivery_status)) return false;
      this.sql.exec(
        `UPDATE active_turns SET delivery_status = ?, updated_at = ?, expires_at = ?
         WHERE thread_key = ? AND execution_id = ? AND stop_event_id = ?`,
        to,
        this.now(),
        this.now() + STOP_CONTINUATION_TTL_MS,
        threadKey,
        executionId,
        stopEventId,
      );
      return this.changed();
    });
  }

  private clearEffect(
    threadKey: string,
    executionId: string,
    token: string,
    resource?: ActiveTurnEffectResource,
  ): boolean {
    return this.tx(() => {
      this.sql.exec(
        `UPDATE active_turns
         SET effect_token = NULL,
             effect_name = NULL,
             effect_resource = COALESCE(?, effect_resource),
             delivery_status = CASE
               WHEN stop_event_id IS NOT NULL THEN 'cancelled'
               ELSE delivery_status
             END,
             expires_at = CASE
               WHEN stop_event_id IS NOT NULL THEN ?
               ELSE expires_at
             END,
             updated_at = ?
         WHERE thread_key = ? AND execution_id = ? AND effect_token = ?
           AND delivery_status = 'pending'`,
        resource ? JSON.stringify(resource) : null,
        this.now() + STOP_CONTINUATION_TTL_MS,
        this.now(),
        threadKey,
        executionId,
        token,
      );
      return this.changed();
    });
  }

  private deleteExpired(threadKey: string): void {
    this.sql.exec(
      `DELETE FROM active_turn_choices
       WHERE thread_key = ? AND EXISTS (
         SELECT 1 FROM active_turns
         WHERE active_turns.thread_key = active_turn_choices.thread_key
           AND active_turns.execution_id = active_turn_choices.execution_id
           AND active_turns.expires_at <= ?
       )`,
      threadKey,
      this.now(),
    );
    this.sql.exec(
      `DELETE FROM active_turns WHERE thread_key = ? AND expires_at <= ?`,
      threadKey,
      this.now(),
    );
  }

  private row(threadKey: string): Row | undefined {
    return this.sql.exec<Row>(
      `SELECT ${COLUMNS} FROM active_turns WHERE thread_key = ?`,
      threadKey,
    ).toArray()[0];
  }

  private changed(): boolean {
    return this.sql.exec<{ n: number }>(`SELECT changes() AS n`).one().n > 0;
  }

  private snapshot(row: Row | undefined): ActiveTurnSnapshot | undefined {
    if (!row) return undefined;
    return {
      record: {
        channelId: row.channel_id,
        threadKey: row.thread_key,
        conversationKey: row.conversation_key,
        executionId: row.execution_id,
        ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
        ...(row.choice_id ? { choiceId: row.choice_id } : {}),
        registeredAt: row.registered_at,
      },
      status: row.delivery_status,
      ...(row.render_token ? { renderToken: row.render_token } : {}),
      ...(row.effect_token ? { effectToken: row.effect_token } : {}),
      ...(row.effect_name ? { effectName: row.effect_name } : {}),
      ...(row.effect_resource
        ? { effectResource: JSON.parse(row.effect_resource) as ActiveTurnEffectResource }
        : {}),
      ...(row.stop_event_id ? { stopEventId: row.stop_event_id } : {}),
      updatedAt: row.updated_at,
    };
  }
}
