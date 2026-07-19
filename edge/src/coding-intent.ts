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

  // Questions and explicit inspection requests are planning/explanation, not
  // authorization to mutate a checkout. Evaluate this before keyword pairs so
  // phrases such as "edit what repository?" cannot accidentally open the
  // remote-git approval gate merely because they contain both terms.
  const confidentlyReadOnly =
    /^(?:(?:please\s+)?(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b|(?:what|why|how|where|when|who|which)\b|can you\s+(?:explain|describe|review|analy[sz]e|summari[sz]e|inspect|read|show|list|find|compare|audit)\b)/i;
  if (confidentlyReadOnly.test(normalized)) return false;

  // A terse follow-up can put the interrogative after a mutation word. This
  // is still asking about the previous claim, not directing a new edit.
  const mutationQuestion =
    /^(?:(?:please|can you|could you|would you)\s+)?(?:add|change|configure|create|delete|edit|fix|implement|modify|patch|refactor|remove|repair|replace|update|write)\s+(?:what|which|where|when|how|why|who)\b/i;
  if (mutationQuestion.test(normalized)) return false;

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

  // A vague imperative that names a repository/codebase is still coding (for
  // example, "take care of the repository"). A bare mention is not.
  return /^(?:(?:please|can you|could you|would you)\s+)?(?:take care of|work on|handle)\b.{0,40}\b(?:codebase|repository|repo|source tree)\b/i.test(
    normalized,
  );
}
