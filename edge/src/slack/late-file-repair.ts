import type { SlackFileRef } from "./download-files.js";

export const LATE_FILE_WINDOW_MS = 15_000;

export type PendingFilelessMention = {
  teamId: string;
  channelId: string;
  userId: string;
  mentionTs: string;
  threadTs: string;
  eventId: string;
  expiresAt: number;
};

export type LateFileEvent = {
  teamId: string;
  channelId: string;
  userId: string;
  fileTs: string;
  threadTs?: string;
  files: SlackFileRef[];
};

export function pendingLateFileKey(value: Pick<PendingFilelessMention, "teamId" | "channelId" | "userId">): string {
  return `late-file:${value.teamId}:${value.channelId}:${value.userId}`;
}

export function lateFileRepairDedupeKey(pending: PendingFilelessMention, event: LateFileEvent): string {
  const ids = event.files.map((file) => file.id ?? file.name ?? "file").sort().join(",");
  return `late-file-repair:${pending.eventId}:${event.fileTs}:${ids}`;
}

/** Pure correlation primitive; callers persist the pending row in a DO/KV. */
export function matchLateFileEvent(
  pending: PendingFilelessMention | undefined,
  event: LateFileEvent,
  now = Date.now(),
): boolean {
  if (!pending || event.files.length === 0 || pending.expiresAt < now) return false;
  if (pending.teamId !== event.teamId || pending.channelId !== event.channelId || pending.userId !== event.userId) return false;
  if (event.threadTs && event.threadTs !== pending.threadTs) return false;
  const delta = Number(event.fileTs) - Number(pending.mentionTs);
  return Number.isFinite(delta) && delta >= 0 && delta * 1000 <= LATE_FILE_WINDOW_MS;
}

export function needsFileInfoHydration(file: SlackFileRef): boolean {
  return !file.url_private || !file.mimetype || typeof file.size !== "number";
}

/** Hydrate Slack's delayed/incomplete file rows before correlation/handoff. */
export async function hydrateLateFileRefs(
  files: SlackFileRef[],
  lookup: (fileId: string) => Promise<SlackFileRef | undefined>,
): Promise<SlackFileRef[]> {
  const hydrated: SlackFileRef[] = [];
  for (const file of files) {
    if (!needsFileInfoHydration(file) || !file.id) {
      hydrated.push(file);
      continue;
    }
    const full = await lookup(file.id);
    hydrated.push(full ? { ...file, ...full, id: file.id } : file);
  }
  return hydrated;
}

/** Bounded exact-idle wait used before synthetic repair pre-admission. */
export async function waitForLateFileThreadIdle(
  isBusy: () => Promise<boolean>,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? LATE_FILE_WINDOW_MS;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (await isBusy()) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  return true;
}
