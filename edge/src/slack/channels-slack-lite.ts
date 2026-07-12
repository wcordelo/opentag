/**
 * Bolt-free Slack pieces for the Worker.
 * Prefer Channels packages when subpath exports cover these; until then we
 * vendor the small pure modules so the Worker never imports SlackAdapter/Bolt.
 */
export {
  normalizeSlackEvent,
  stripMentions,
  deriveEventId,
  isPlainUserMessage,
} from "./ingress-normalize.js";
export type { SlackNeutralEvent, PlainUserMessage } from "./ingress-normalize.js";

export { conversationKeyOf, decodeInteraction } from "./interaction.js";
export { DM_SCOPE } from "./types.js";
export { defaultSlackContext } from "./built-in-context.js";
