/**
 * Pure social acknowledgments — prefer a Slack reaction over a text reply.
 */
export type TrivialAck =
  | { mode: "react"; emoji: string }
  | { mode: "text"; text: string };

export function trivialAck(raw: string): TrivialAck | null {
  const text = raw
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 48) return null;
  const t = text.toLowerCase().replace(/[!?.]+$/g, "").trim();
  if (
    /^(thanks|thank you|thx|ty|thankyou)(\s+(so|very)\s+much)?$/.test(t) ||
    /^(ok|okay)(\s+(great|cool|thanks|thank you|perfect))?(\s+thank you)?$/.test(
      t,
    ) ||
    /^(got it|sounds good|perfect|awesome|cool|great|nice|👍|🙏)$/.test(t)
  ) {
    if (/thank|thx|ty|🙏/.test(t)) return { mode: "react", emoji: "heart" };
    return { mode: "react", emoji: "thumbsup" };
  }
  return null;
}
