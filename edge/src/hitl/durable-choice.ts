/**
 * Cross-isolate HITL for `thread.awaitChoice`.
 *
 * `@copilotkit/channels` keeps awaitChoice waiters in an in-memory Map. On
 * Cloudflare Workers, Slack block_actions often hit a different isolate than
 * the turn that posted the card — the waiter is missing and Create/Cancel
 * appear dead.
 *
 * Fix: embed a `choiceId` in every button value, persist clicks under
 * `hitl-id:{choiceId}` (and conversationKey as a fallback), and race the
 * in-memory waiter against a DO poll of that id. Matching conversationKey is
 * no longer required for the click to unblock the waiting turn.
 */
import type { StateStore } from "../store/state-store-contract.js";
import type { Renderable } from "@copilotkit/channels-ui";

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
): Promise<void> {
  const record: HitlChoiceRecord = { value, at: Date.now() };
  const choiceId = choiceIdFromValue(value);
  if (choiceId) {
    await store.kv.set(hitlIdKey(choiceId), record, ttlMs);
  }
  if (conversationKey) {
    await store.kv.set(hitlChoiceKey(conversationKey), record, ttlMs);
  }
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
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? HITL_CHOICE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? HITL_CHOICE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const keys = {
    conversationKey: opts.conversationKey,
    choiceId: opts.choiceId,
  };

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const value = await readHitlChoice(store, keys);
    if (value !== undefined) {
      await clearHitlChoice(store, keys);
      return value;
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
  },
): Promise<T> {
  const conversationKey = opts.conversationKey ?? thread.conversationKey ?? "";
  await clearHitlChoice(store, {
    choiceId: opts.choiceId,
    conversationKey: conversationKey || undefined,
  });

  const ac = new AbortController();
  const memory = thread.awaitChoice<T>(ui).then((v) => {
    ac.abort();
    return v;
  });

  const durable = pollHitlChoice(store, {
    choiceId: opts.choiceId,
    conversationKey: conversationKey || undefined,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    signal: ac.signal,
  })
    .then((v) => v as T)
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        return memory;
      }
      throw err;
    });

  try {
    return await Promise.race([memory, durable]);
  } finally {
    ac.abort();
  }
}
