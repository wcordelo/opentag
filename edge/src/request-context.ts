/**
 * Request-scoped team id for commands/tools.
 * Stack-based (no node:async_hooks) so the Worker bundle stays free of
 * createRequire(import.meta.url) shims that crash workerd.
 *
 * Handles both sync and async `fn` — the frame stays until a returned
 * Promise settles.
 */
type Store = { teamId: string };

const stack: Store[] = [];
let fallbackTeamId = "default";

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
  stack.push({ teamId: teamId || "default" });
  try {
    const result = fn();
    if (isThenable(result)) {
      return result.then(
        (v) => {
          stack.pop();
          return v;
        },
        (err) => {
          stack.pop();
          throw err;
        },
      ) as T;
    }
    stack.pop();
    return result;
  } catch (err) {
    stack.pop();
    throw err;
  }
}

/** Reset fallback (tests). */
export function resetRequestContext(): void {
  fallbackTeamId = "default";
  stack.length = 0;
}
