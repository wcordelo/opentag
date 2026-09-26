/**
 * Neutral installation defaults for the public upstream.
 *
 * Downstream deployment repos override these via Worker vars / secrets.
 * Keep new keys minimal — downstream `edge/src/env.ts` must declare each one.
 */

/** Default Linear team display name when `LINEAR_TEAM_KEY` is unset. */
export const DEFAULT_LINEAR_TEAM_KEY = "example-org";

/** Default Linear workspace slug for issue URLs when `LINEAR_WORKSPACE_SLUG` is unset. */
export const DEFAULT_LINEAR_WORKSPACE_SLUG = "example-org";

export function resolveLinearTeamKey(raw?: string): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LINEAR_TEAM_KEY;
}

export function resolveLinearWorkspaceSlug(raw?: string): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LINEAR_WORKSPACE_SLUG;
}

/** Read optional Worker env without requiring the key on `Env`. */
export function readOptionalEnvString(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
