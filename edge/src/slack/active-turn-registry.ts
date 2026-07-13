import type { StateStore } from "../store/state-store-contract.js";

export const ACTIVE_TURN_TTL_MS = 20 * 60_000;

export type ActiveTurnRecord = {
  channelId: string;
  threadKey: string;
  conversationKey: string;
  executionId: string;
  threadTs?: string;
  choiceId?: string;
  registeredAt: number;
};

type ActiveTurnRegistryEvent =
  | { type: "start"; record: ActiveTurnRecord }
  | { type: "end"; threadKey: string; executionId: string };

export function activeTurnThreadKvKey(threadKey: string): string {
  return `active-turn:thread:${threadKey}`;
}

export function activeTurnRegistryKey(channelId: string): string {
  return `active-turn:channel:${channelId}`;
}

export async function registerActiveTurn(
  store: StateStore,
  record: ActiveTurnRecord,
): Promise<{ accepted: boolean; duplicate: boolean }> {
  const key = activeTurnThreadKvKey(record.threadKey);
  const lockKey = `${key}:lock`;
  const lock = await store.lock.acquire(lockKey, { ttlMs: 5_000 });
  if (!lock) return { accepted: false, duplicate: false };
  try {
    const current = await store.kv.get<ActiveTurnRecord>(key);
    if (current) {
      return {
        accepted: false,
        duplicate: current.executionId === record.executionId,
      };
    }
    await store.kv.set(key, record, ACTIVE_TURN_TTL_MS);
    await store.list.append<ActiveTurnRegistryEvent>(
      activeTurnRegistryKey(record.channelId),
      { type: "start", record },
      { maxLen: 200, ttlMs: ACTIVE_TURN_TTL_MS },
    );
    return { accepted: true, duplicate: false };
  } finally {
    await store.lock.release(lockKey, lock.token);
  }
}

/** Compare-and-delete: an older completion cannot erase a newer thread turn. */
export async function clearActiveTurn(
  store: StateStore,
  record: Pick<ActiveTurnRecord, "channelId" | "threadKey" | "executionId">,
): Promise<void> {
  const key = activeTurnThreadKvKey(record.threadKey);
  const lockKey = `${key}:lock`;
  const lock = await store.lock.acquire(lockKey, { ttlMs: 5_000 });
  if (!lock) return;
  try {
    const current = await store.kv.get<ActiveTurnRecord>(key);
    if (current?.executionId === record.executionId) await store.kv.delete(key);
    await store.list.append<ActiveTurnRegistryEvent>(
      activeTurnRegistryKey(record.channelId),
      { type: "end", threadKey: record.threadKey, executionId: record.executionId },
      { maxLen: 200, ttlMs: ACTIVE_TURN_TTL_MS },
    );
  } finally {
    await store.lock.release(lockKey, lock.token);
  }
}

export async function getActiveTurnForThread(
  store: StateStore,
  threadKey: string,
): Promise<ActiveTurnRecord | undefined> {
  return store.kv.get<ActiveTurnRecord>(activeTurnThreadKvKey(threadKey));
}

/** Newest still-authoritative active turn in a channel (for unthreaded Stop). */
export async function getLatestActiveTurn(
  store: StateStore,
  channelId: string,
): Promise<ActiveTurnRecord | undefined> {
  const events = await store.list.range<ActiveTurnRegistryEvent>(
    activeTurnRegistryKey(channelId),
  );
  const active = new Map<string, ActiveTurnRecord>();
  for (const event of events) {
    if (event.type === "start") active.set(event.record.threadKey, event.record);
    else if (active.get(event.threadKey)?.executionId === event.executionId) {
      active.delete(event.threadKey);
    }
  }
  const candidates = [...active.values()].sort((a, b) =>
    b.registeredAt - a.registeredAt || b.executionId.localeCompare(a.executionId),
  );
  for (const candidate of candidates) {
    const current = await getActiveTurnForThread(store, candidate.threadKey);
    if (current?.executionId === candidate.executionId) return current;
  }
  return undefined;
}
