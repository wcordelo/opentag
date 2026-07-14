/**
 * Cross-isolate HITL for `thread.awaitChoice`.
 *
 * `@copilotkit/channels` keeps awaitChoice waiters in an in-memory Map. On
 * Cloudflare Workers, Slack block_actions often hit a different isolate than
 * the turn that posted the card — the waiter is missing and Create/Cancel
 * appear dead.
 *
 * Fix: embed a `choiceId` in every button value, persist modern clicks under
 * `hitl-id:{choiceId}` (conversationKey remains for legacy id-less values),
 * and resolve privileged choices from a DO poll of that id. Generic choices
 * may still race the local waiter for compatibility, but remote-git approval
 * requires the exact durable receipt. Matching conversationKey is no longer
 * required to unblock the turn.
 */
import type { StateStore } from "../store/state-store-contract.js";
import type { Renderable } from "@copilotkit/channels-ui";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

export const HITL_CHOICE_TTL_MS = 10 * 60_000;
export const HITL_CHOICE_POLL_MS = 100;
/** Max time to wait for a click (matches typical Slack HITL UX). */
export const HITL_CHOICE_TIMEOUT_MS = 10 * 60_000;

export type HitlChoiceRecord = {
  value: unknown;
  at: number;
};

export function hitlChoiceKey(conversationKey: string): string {
  return `hitl-choice:${conversationKey}`;
}

export function hitlIdKey(choiceId: string): string {
  return `hitl-id:${choiceId}`;
}

export function hitlCancelledKey(choiceId: string): string {
  return `hitl-cancelled:${choiceId}`;
}

export function newHitlChoiceId(): string {
  return crypto.randomUUID();
}

/** Extract choiceId from a Slack button value, if present. */
export function choiceIdFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { choiceId?: unknown }).choiceId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export async function persistHitlChoice(
  store: StateStore,
  conversationKey: string,
  value: unknown,
  ttlMs: number = HITL_CHOICE_TTL_MS,
): Promise<"persisted" | "cancelled"> {
  const choiceId = choiceIdFromValue(value);
  const record: HitlChoiceRecord = { value, at: Date.now() };
  // The exact choice-id receipt is the single commit point whenever modern
  // button values carry one. Conversation keys remain a legacy fallback only
  // for values without an id, avoiding partially persisted affirmatives.
  if (choiceId) {
    if (!store.hitl) throw new Error("atomic_hitl_unavailable");
    return store.hitl.persistChoiceUnlessCancelled({
      choiceKey: hitlIdKey(choiceId),
      cancelledKey: hitlCancelledKey(choiceId),
      record,
      ttlMs,
    });
  } else if (conversationKey) {
    await store.kv.set(hitlChoiceKey(conversationKey), record, ttlMs);
  }
  return "persisted";
}

/** Wake a durable waiter with a denial and make all later clicks no-ops. */
export async function cancelHitlChoice(
  store: StateStore,
  opts: { conversationKey?: string; choiceId: string },
): Promise<void> {
  const record: HitlChoiceRecord = { value: {
    confirmed: false,
    choiceId: opts.choiceId,
  }, at: Date.now() };
  if (!store.hitl) throw new Error("atomic_hitl_unavailable");
  await store.hitl.cancelChoice({
    choiceKey: hitlIdKey(opts.choiceId),
    cancelledKey: hitlCancelledKey(opts.choiceId),
    denial: record,
    ttlMs: HITL_CHOICE_TTL_MS,
  });
}

export async function clearHitlChoice(
  store: StateStore,
  opts: { conversationKey?: string; choiceId?: string },
): Promise<void> {
  if (opts.choiceId) await store.kv.delete(hitlIdKey(opts.choiceId));
  if (opts.conversationKey) {
    await store.kv.delete(hitlChoiceKey(opts.conversationKey));
  }
}

export async function readHitlChoice(
  store: StateStore,
  opts: { conversationKey?: string; choiceId?: string },
): Promise<unknown | undefined> {
  if (opts.choiceId) {
    const byId = await store.kv.get<HitlChoiceRecord>(hitlIdKey(opts.choiceId));
    if (byId && typeof byId === "object" && "value" in byId) {
      return byId.value;
    }
  }
  if (opts.conversationKey) {
    const byCk = await store.kv.get<HitlChoiceRecord>(
      hitlChoiceKey(opts.conversationKey),
    );
    if (byCk && typeof byCk === "object" && "value" in byCk) {
      return byCk.value;
    }
  }
  return undefined;
}

function valueFromRecord(record: unknown): unknown {
  if (record && typeof record === "object" && "value" in record) {
    return (record as HitlChoiceRecord).value;
  }
  throw new Error("invalid_hitl_choice_record");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Poll DO for a choice written by {@link persistHitlChoice}.
 * Prefers `choiceId` key; falls back to conversationKey.
 */
export async function pollHitlChoice(
  store: StateStore,
  opts: {
    conversationKey?: string;
    choiceId?: string;
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    choiceIdOnly?: boolean;
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? HITL_CHOICE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? HITL_CHOICE_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (opts.choiceId) {
      if (!store.hitl) throw new Error("atomic_hitl_unavailable");
      const consumed = await store.hitl.consumeChoice({
        choiceKey: hitlIdKey(opts.choiceId),
        cancelledKey: hitlCancelledKey(opts.choiceId),
      });
      if (consumed.status !== "pending") {
        return valueFromRecord(consumed.record);
      }
    }
    if (!opts.choiceIdOnly && opts.conversationKey) {
      const value = await readHitlChoice(store, {
        conversationKey: opts.conversationKey,
      });
      if (value !== undefined) {
        await clearHitlChoice(store, {
          conversationKey: opts.conversationKey,
        });
        return value;
      }
    }
    await sleep(pollMs, opts.signal);
  }
  throw new Error(
    `HITL choice timed out after ${timeoutMs}ms id=${opts.choiceId ?? "?"} ck=${opts.conversationKey ?? "?"}`,
  );
}

type AwaitChoiceThread = {
  conversationKey?: string;
  awaitChoice<T = unknown>(ui: Renderable): Promise<T>;
};

/**
 * Post a picker via `thread.awaitChoice`, but also win if the click is handled
 * on another isolate that only wrote to StateStore (by choiceId).
 */
export async function awaitChoiceDurable<T>(
  thread: AwaitChoiceThread,
  store: StateStore,
  ui: Renderable,
  opts: {
    choiceId: string;
    timeoutMs?: number;
    pollMs?: number;
    conversationKey?: string;
    /** Require the exact durable choice-id receipt; in-memory delivery cannot grant. */
    requireDurableReceipt?: boolean;
    /** Isolated unit-test escape hatch; forbidden on production tool paths. */
    unsafeAllowMissingExecutionContextTestOnly?: boolean;
  },
): Promise<T> {
  const conversationKey = opts.conversationKey ?? thread.conversationKey ?? "";
  if (!store.hitl) throw new Error("atomic_hitl_unavailable");
  const exact = getTurnExecutionContext(thread);
  if (!exact && opts.unsafeAllowMissingExecutionContextTestOnly !== true) {
    throw new Error("exact_execution_context_required_for_hitl");
  }
  const lifecycle = store as StateStore & {
    activeTurn?: {
      registerChoice(args: {
        threadKey: string;
        executionId: string;
        choiceId: string;
      }): Promise<"registered" | "cancelled" | "missing">;
      unregisterChoice(args: {
        threadKey: string;
        executionId: string;
        choiceId: string;
      }): Promise<boolean>;
    };
  };
  let registered = false;
  if (exact) {
    if (!lifecycle.activeTurn) {
      throw new Error("active_turn_choice_registry_unavailable");
    }
    const result = await lifecycle.activeTurn.registerChoice({
      ...exact,
      choiceId: opts.choiceId,
    });
    if (result !== "registered") {
      // Never render or resolve a picker after exact Stop (or after its active
      // row has disappeared). Throwing prevents non-confirmation tools from
      // misreading a denial-shaped object as a successful action.
      throw new Error("active_turn_not_active_for_hitl");
    }
    registered = true;
  }
  let ac: AbortController | undefined;
  try {
    // One DO transaction either clears an old receipt or observes the exact
    // Stop denial. A separate tombstone read followed by delete would let a
    // Stop land between those calls and have its denial erased by setup.
    const prepared = await store.hitl.prepareChoice({
      choiceKey: hitlIdKey(opts.choiceId),
      cancelledKey: hitlCancelledKey(opts.choiceId),
    });
    if (prepared.status === "cancelled") {
      return valueFromRecord(prepared.record) as T;
    }
    if (conversationKey) {
      await clearHitlChoice(store, { conversationKey });
    }

    ac = new AbortController();
    const memory = thread.awaitChoice<T>(ui);
    const requireDurableReceipt =
      exact !== undefined || opts.requireDurableReceipt === true;
    const memoryWinner = requireDurableReceipt
      ? undefined
      : memory.then((v) => {
          ac!.abort();
          return v;
        });
    if (requireDurableReceipt) void memory.catch(() => undefined);

    const durable = pollHitlChoice(store, {
      choiceId: opts.choiceId,
      conversationKey: conversationKey || undefined,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      signal: ac.signal,
      choiceIdOnly: requireDurableReceipt,
    })
      .then((v) => v as T)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return memoryWinner ?? Promise.reject(err);
        }
        throw err;
      });

    return requireDurableReceipt
      ? await durable
      : await Promise.race([memoryWinner!, durable]);
  } finally {
    ac?.abort();
    // Exact-id receipts are consumed transactionally by pollHitlChoice. Never
    // issue an unconditional exact-key delete here: Stop may have installed a
    // newer denial after the consume linearization point.
    await clearHitlChoice(store, {
      conversationKey: conversationKey || undefined,
    });
    if (registered && exact) {
      await lifecycle.activeTurn!.unregisterChoice({
        ...exact,
        choiceId: opts.choiceId,
      });
    }
  }
}
