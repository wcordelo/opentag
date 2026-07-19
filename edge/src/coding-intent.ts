/**
 * One classifier for every repo-backed Claude Code gate. A coding turn needs
 * both a mutation signal and a repository artifact (or an explicit remote-git
 * operation); ordinary product actions stay on the default AG-UI runtime.
 */
export function isRepositoryCodingIntent(text: string): boolean {
  const normalized = text
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const remoteGitMutation =
    /\b(?:open|create|raise)\b.{0,24}\b(?:pull request|pr)\b|\bpush\b.{0,40}\b(?:branch|changes?|code|commit|pr|repository|repo)\b|\bcommit\b.{0,40}\b(?:changes?|code|files?|repository|repo)\b/i;
  if (remoteGitMutation.test(normalized)) return true;

  const repositoryMutation =
    /\b(?:add|change|configure|create|delete|edit|fix|generate|implement|install|make|migrate|modify|patch|publish|refactor|remove|rename|repair|replace|resolve|revert|scaffold|update|upgrade|write)\b/i;
  const repositoryArtifact =
    /\b(?:api|branch|build|check|ci|class|client|code|codebase|commit|component|config|database|dependency|dockerfile|endpoint|file|function|harness|migration|module|package|repository|repo|router|schema|script|service|source|test|worker|workflow)\b/i;
  const commandMutation =
    /^(?:(?:please|can you|could you|would you)\s+)?(?:test|build|script|config|deploy)\b|\b(?:and|then)\s+(?:test|build|script|config|deploy)\b/i;
  if (
    (repositoryMutation.test(normalized) && repositoryArtifact.test(normalized)) ||
    commandMutation.test(normalized)
  ) {
    return true;
  }

  const confidentlyReadOnly =
    /^(?:(?:please\s+)?(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b|(?:what|why|how|where|when|who|which)\b|can you\s+(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b)/i;
  if (confidentlyReadOnly.test(normalized)) return false;

  // An imperative that names a repository/codebase is still coding even when
  // its verb is vague (for example, "take care of the repository").
  return /\b(?:codebase|repository|repo|source tree)\b/i.test(normalized);
}
