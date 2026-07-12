/**
 * Request-scoped context for commands/tools.
 * Stack-based (no node:async_hooks) so the Worker bundle stays free of
 * createRequire(import.meta.url) shims that crash workerd.
 *
 * Handles both sync and async `fn` — the frame stays until a returned
 * Promise settles.
 */
export type InboundMessageTarget = { channel: string; ts: string };

type Store = {
  teamId: string;
  inbound?: InboundMessageTarget;
};

const stack: Store[] = [];
let fallbackTeamId = "default";
let fallbackInbound: InboundMessageTarget | undefined;

export function setCurrentTeamId(teamId: string): void {
  const id = teamId || "default";
  const store = stack[stack.length - 1];
  if (store) {
    store.teamId = id;
  } else {
    fallbackTeamId = id;
  }
}

export function getCurrentTeamId(): string {
  return stack[stack.length - 1]?.teamId ?? fallbackTeamId;
}

/** Stash the Slack message this turn should react to (channel + ts). */
export function setCurrentInboundMessage(
  channel: string,
  ts: string,
): void {
  if (!channel || !ts) return;
  const target = { channel, ts };
  const store = stack[stack.length - 1];
  if (store) {
    store.inbound = target;
  } else {
    fallbackInbound = target;
  }
}

export function getCurrentInboundMessage():
  | InboundMessageTarget
  | undefined {
  return stack[stack.length - 1]?.inbound ?? fallbackInbound;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "then" in v &&
    typeof (v as { then: unknown }).then === "function"
  );
}

/** Run `fn` with an isolated team id for the call tree (incl. awaited work). */
export function runWithTeamId<T>(teamId: string, fn: () => T): T {
  const frame: Store = { teamId: teamId || "default" };
  stack.push(frame);
  const cleanup = () => {
    const i = stack.indexOf(frame);
    if (i !== -1) stack.splice(i, 1);
  };
  try {
    const result = fn();
    if (isThenable(result)) {
      return result.then(
        (v) => {
          cleanup();
          return v;
        },
        (err) => {
          cleanup();
          throw err;
        },
      ) as T;
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Reset fallback (tests). */
export function resetRequestContext(): void {
  fallbackTeamId = "default";
  fallbackInbound = undefined;
  stack.length = 0;
}
