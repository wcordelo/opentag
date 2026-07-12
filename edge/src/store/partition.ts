/**
 * Maps a StateStore key to the **name** of the Durable Object instance that
 * owns it. The only hard requirement is determinism: a given key must always
 * resolve to the same instance. Beyond that it's a locality/scaling knob.
 */
export type Partitioner = (key: string) => string;

/**
 * Default: one global Durable Object holds all state. Simplest and always
 * correct; the bot already serializes work per conversation via its turn lock,
 * so a single instance is a fine starting point.
 */
export const singleGlobal: Partitioner = () => "global";

/**
 * Locality-oriented partitioner: co-locate every key for one logical
 * conversation on one Durable Object so its kv/list/lock/dedup rows live in the
 * same embedded SQLite DB.
 *
 * `@copilotkit/bot` keys per-conversation state with a stable suffix after the
 * first `:` — `conv:<key>`, `turn:<key>`, `threadstate:<key>`, `sub:<key>`.
 * We route on that suffix. Non-conversation keys (`action:<id>`, dedup hashes)
 * fall back to their own deterministic instance, which is harmless: correctness
 * never depends on *which* instance, only that it's consistent.
 */
export function byConversationKey(prefix = "conv"): Partitioner {
  return (key: string): string => {
    const idx = key.indexOf(":");
    if (idx === -1) return `${prefix}:${key}`;
    return `${prefix}:${key.slice(idx + 1)}`;
  };
}
