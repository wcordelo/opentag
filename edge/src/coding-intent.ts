/**
 * One conservative classifier for every repo-backed Claude Code gate.
 * Unknown/ambiguous work is coding by default; only a confidently read-only
 * request with no mutation signal can bypass coding policy and HITL.
 */
export function isRepositoryCodingIntent(text: string): boolean {
  const normalized = text
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const unambiguousMutation =
    /\b(?:add|change|configure|create|delete|edit|fix|generate|implement|install|make|migrate|modify|patch|publish|push|refactor|remove|rename|repair|replace|resolve|revert|scaffold|update|upgrade|write)\b|\b(?:open|create|raise)\b.{0,24}\b(?:pull request|pr)\b|\bcommit\b.{0,24}\b(?:changes?|code|files?)\b/i;
  const commandMutation =
    /^(?:(?:please|can you|could you|would you)\s+)?(?:test|build|script|config|deploy)\b|\b(?:and|then)\s+(?:test|build|script|config|deploy)\b/i;
  if (unambiguousMutation.test(normalized) || commandMutation.test(normalized)) {
    return true;
  }

  const confidentlyReadOnly =
    /^(?:(?:please\s+)?(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b|(?:what|why|how|where|when|who|which)\b|can you\s+(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b)/i;
  return !confidentlyReadOnly.test(normalized);
}
