/**
 * Request-scoped team id for commands/tools.
 * Uses AsyncLocalStorage so concurrent Slack turns don't cross workspaces.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ teamId: string }>();

/** Fallback when outside a request (tests / cold paths). */
let fallbackTeamId = "default";

export function setCurrentTeamId(teamId: string): void {
  const id = teamId || "default";
  const store = als.getStore();
  if (store) {
    store.teamId = id;
  } else {
    fallbackTeamId = id;
  }
}

export function getCurrentTeamId(): string {
  return als.getStore()?.teamId ?? fallbackTeamId;
}

/** Run `fn` with an isolated team id for the async call tree. */
export function runWithTeamId<T>(teamId: string, fn: () => T): T {
  return als.run({ teamId: teamId || "default" }, fn);
}

/** Reset fallback (tests). */
export function resetRequestContext(): void {
  fallbackTeamId = "default";
}
