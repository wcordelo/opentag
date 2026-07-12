/**
 * Quick artifact card — decorates final agent messages that contain an
 * artifact/report URL (https://<artifact-id>.<baseDomain>) with an
 * interactive card (ported from centaur's quick-card.ts, generalized: opentag
 * has no fixed Quick site domain, so the base domain is a parameter):
 *
 *   [ Re-generate ]  [ View files ]  [ Delete ]
 *
 * Button clicks arrive as Slack block_actions (see quick-actions.ts) and are
 * converted into ordinary agent turns in the same thread, so they inherit the
 * clicking user's requester identity, dedup, and the turn lock.
 */
import { jsx, jsxs } from "@copilotkit/channels-ui/jsx-runtime";
import type { BotNode } from "@copilotkit/channels-ui";
import {
  Message,
  Section,
  Actions,
  Button,
  Context,
} from "@copilotkit/channels-ui";

export const QUICK_ACTION_PREFIX = "quick_";

export type QuickActionKind = "regenerate" | "files" | "delete" | "retry";

/** Ref carried in a quick button's `value` (JSON, ≤2,000 chars on Slack). */
export type QuickRef =
  | { type: "artifact"; artifactId: string; url: string }
  | { type: "issue_list"; heading?: string };

/** DNS label: 1-63 chars, lowercase alphanumerics, internal hyphens. */
const ARTIFACT_ID = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** Slack Block Kit caps messages at 50 blocks; each artifact uses section + actions. */
const SLACK_BLOCK_LIMIT = 50;
const BLOCKS_PER_ARTIFACT = 2;
export const MAX_QUICK_CARD_ARTIFACTS = Math.floor(
  SLACK_BLOCK_LIMIT / BLOCKS_PER_ARTIFACT,
);

/** Slack caps button values at 2,000 chars; keep refs comfortably under it. */
export const MAX_QUICK_VALUE_CHARS = 2000;

/** The Slack action_id a quick button click is routed to. */
export function quickActionId(kind: QuickActionKind): string {
  return `${QUICK_ACTION_PREFIX}${kind}`;
}

/**
 * Registry-style stamped handler: the Block Kit renderer derives a button's
 * `action_id` from `onClick.id` (see channels-slack block-kit.js
 * buttonActionId/idFromHandler), which is how these buttons get a stable
 * `quick_*` action_id that worker.ts can dispatch on without the framework's
 * action registry.
 */
export function quickActionHandle(kind: QuickActionKind): never {
  return { id: quickActionId(kind) } as never;
}

export function findQuickSiteUrls(
  text: string,
  baseDomain: string,
): Array<Extract<QuickRef, { type: "artifact" }>> {
  if (!text || !baseDomain) return [];
  const domain = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `https://(${ARTIFACT_ID})\\.${domain}(?![A-Za-z0-9.-])(?:/[^\\s<>|]*)?`,
    "g",
  );
  const seen = new Set<string>();
  const refs: Array<Extract<QuickRef, { type: "artifact" }>> = [];
  for (const match of text.matchAll(re)) {
    const artifactId = match[1];
    if (!artifactId || seen.has(artifactId)) continue;
    seen.add(artifactId);
    refs.push({
      type: "artifact",
      artifactId,
      url: `https://${artifactId}.${baseDomain}`,
    });
  }
  return refs;
}

/**
 * Build an interactive card for every artifact URL referenced in `text`, or
 * null if the message contains none. Each button's `value` carries the ref so
 * the action handler knows what to act on.
 */
export function buildQuickDeployCard(
  text: string,
  baseDomain: string,
): BotNode | null {
  return buildQuickDeployCardFromRefs(findQuickSiteUrls(text, baseDomain));
}

/** Build a card for an explicit list of artifact refs (used for deduped posts). */
export function buildQuickDeployCardFromRefs(
  refs: Array<Extract<QuickRef, { type: "artifact" }>>,
): BotNode | null {
  if (refs.length === 0) return null;

  // When some artifacts are omitted, reserve one block for the omission note —
  // otherwise the note itself would be the 51st block and get clamped away.
  const maxShown =
    refs.length > MAX_QUICK_CARD_ARTIFACTS
      ? MAX_QUICK_CARD_ARTIFACTS - 1
      : MAX_QUICK_CARD_ARTIFACTS;
  const shown = refs.slice(0, maxShown);
  const omitted = refs.length - shown.length;
  const children: BotNode[] = [];
  for (const ref of shown) {
    children.push(
      jsx(Section, {
        children: `⚡ Artifact *${ref.artifactId}* — [open](${ref.url})`,
      }),
      jsxs(Actions, {
        children: [
          jsx(Button, {
            onClick: quickActionHandle("regenerate"),
            value: ref,
            children: "Re-generate",
          }),
          jsx(Button, {
            onClick: quickActionHandle("files"),
            value: ref,
            children: "View files",
          }),
          jsx(Button, {
            onClick: quickActionHandle("delete"),
            style: "danger",
            value: ref,
            children: "Delete",
          }),
        ],
      }),
    );
  }
  if (omitted > 0) {
    children.push(
      jsx(Context, {
        children: `…and ${omitted} more artifact${omitted === 1 ? "" : "s"} not shown (Slack block limit).`,
      }),
    );
  }
  return jsxs(Message, { children });
}
