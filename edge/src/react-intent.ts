/**
 * Explicit “react to my message” / “don’t react” intents — handle without LLM.
 */
export type ReactIntent =
  | { action: "react"; emoji: string }
  | { action: "skip" };

const DEFAULT_EMOJI = "+1";

/** Known Slack reaction names we accept from natural language. */
const KNOWN: Record<string, string> = {
  thumbs_up: "+1",
  thumbsup: "+1",
  "+1": "+1",
  like: "+1",
  thumbs_down: "-1",
  thumbsdown: "-1",
  "-1": "-1",
  heart: "heart",
  love: "heart",
  eyes: "eyes",
  fire: "fire",
  check: "white_check_mark",
  checkmark: "white_check_mark",
  white_check_mark: "white_check_mark",
  tada: "tada",
  wave: "wave",
  rocket: "rocket",
  smile: "smile",
  thinking: "thinking_face",
  thinking_face: "thinking_face",
};

/** Map common names / shortcodes to Slack reaction names (no colons). */
export function normalizeEmojiToken(raw: string): string {
  const t = raw.replace(/^:|:$/g, "").trim().toLowerCase();
  if (!t) return DEFAULT_EMOJI;
  // LLM / phrasing artifacts: "no heart" → no_heart
  if (/^(no|not|without)_/.test(t)) return DEFAULT_EMOJI;
  if (KNOWN[t]) return KNOWN[t];
  // Allow custom workspace emoji names; reject junk.
  if (/^[a-z0-9_+-]{1,64}$/.test(t)) return t;
  return DEFAULT_EMOJI;
}

/**
 * Pull an emoji from "with …" / "using …", ignoring negations like
 * "with no heart" / "without fire" (those fall back to the default).
 */
function emojiFromText(t: string): string {
  // "with no heart", "without heart", "with not heart" → default
  if (
    /\bwith\s+(no|not)\s+\w+/.test(t) ||
    /\bwithout\s+\w+/.test(t) ||
    /\busing\s+(no|not)\s+\w+/.test(t)
  ) {
    return DEFAULT_EMOJI;
  }
  const withEmoji =
    t.match(/\bwith\s+:?([a-z0-9_+-]+):?/) ??
    t.match(/\busing\s+:?([a-z0-9_+-]+):?/);
  if (!withEmoji?.[1]) return DEFAULT_EMOJI;
  return normalizeEmojiToken(withEmoji[1]);
}

/**
 * Detect explicit react / don't-react commands.
 * Returns null when the message is not a react intent (normal agent turn).
 */
export function reactIntent(raw: string): ReactIntent | null {
  const text = raw
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 120) return null;
  const t = text.toLowerCase().replace(/[!?.]+$/g, "").trim();

  // Negatives first — "don't react to my message"
  if (
    /\b(don'?t|do not|never|stop)\b.{0,20}\breact\b/.test(t) ||
    /\bno\s+reactions?\b/.test(t)
  ) {
    return { action: "skip" };
  }

  // "react to my/this/that message", "react with heart", "react to this with fire"
  if (
    /\breact\b.{0,40}\b(my|this|that|the)\b.{0,24}\bmes+a?ges?\b/.test(t) ||
    /\breact\b.{0,24}\b(my|this|that)\b.{0,24}\bwith\b/.test(t) ||
    /^\s*react\s+with\b/.test(t) ||
    /^\s*react\s+without\b/.test(t) ||
    /^\s*react\s+using\b/.test(t) ||
    /^\s*react\s+to\s+(it|this|that)\s*$/.test(t) ||
    /^\s*(please\s+)?react(\s+please)?\s*$/.test(t) ||
    /^\s*add\s+(a\s+)?reaction\b/.test(t)
  ) {
    return { action: "react", emoji: emojiFromText(t) };
  }

  return null;
}
