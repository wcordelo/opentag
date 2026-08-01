import type { Env } from "../env.js";
import { legacySlackObligationThreadKeyFromKey } from "./obligation-thread-key.js";

interface SessionPartitionRpc {
  getState(): Promise<{ sessionId?: string }>;
  replay(afterEventId?: number): Promise<unknown[]>;
  getProviderState?(): Promise<unknown>;
}

async function partitionHasSession(
  namespace: NonNullable<Env["SESSION_EVENTS"]>,
  threadKey: string,
): Promise<boolean> {
  const stub = namespace.get(
    namespace.idFromName(threadKey),
  ) as unknown as SessionPartitionRpc;
  try {
    const state = await stub.getState();
    if (state.sessionId) return true;
    if ((await stub.replay(0)).length > 0) return true;
    if (stub.getProviderState && (await stub.getProviderState()) !== undefined) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Prefer the tenant-qualified partition, but keep reading legacy
 * `SessionEventDO` state created before tenant qualification rolled out.
 */
export async function resolveSessionEventThreadKey(
  env: Pick<Env, "SESSION_EVENTS">,
  threadKey: string,
): Promise<string> {
  const legacyThreadKey = legacySlackObligationThreadKeyFromKey(threadKey);
  if (!legacyThreadKey || !env.SESSION_EVENTS) return threadKey;
  const [legacyHasSession, currentHasSession] = await Promise.all([
    partitionHasSession(env.SESSION_EVENTS, legacyThreadKey),
    partitionHasSession(env.SESSION_EVENTS, threadKey),
  ]);
  if (legacyHasSession && !currentHasSession) return legacyThreadKey;
  return threadKey;
}
