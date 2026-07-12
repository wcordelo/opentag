import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import type { Env } from "./env.js";

/**
 * Build container process env from Worker secrets/vars.
 *
 * Must be assigned as a **class field** (`envVars = triageEnvVars()`), not a
 * getter: `@cloudflare/containers` sets `envVars = {}` on the base class, which
 * becomes an own property and shadows any subclass getter — leaving the
 * container with no OPENAI_API_KEY / Linear secrets.
 */
function triageEnvVars(): Record<string, string> {
  const e = env as Env;
  const out: Record<string, string> = {
    PORT: "8200",
    NOTION_MCP_URL: "http://127.0.0.1:3001/mcp",
    LINEAR_TEAM_KEY: "Berendo",
  };
  const keys = [
    "OPENAI_API_KEY",
    "AGENT_MODEL",
    "LINEAR_API_KEY",
    "LINEAR_MCP_URL",
    "LINEAR_TEAM_KEY",
    "NOTION_TOKEN",
    "NOTION_MCP_AUTH_TOKEN",
    "NOTION_MCP_PORT",
  ] as const;
  for (const key of keys) {
    const value = e[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  if (out.LINEAR_TEAM_KEY === "CPK") {
    out.LINEAR_TEAM_KEY = "Berendo";
  }
  return out;
}

/**
 * Single always-on triage container hosting Node `runtime.ts` (AG-UI).
 *
 * Distinct from deferred pm/impl/verify sandbox containers: this process holds
 * long-lived API keys (same as laptop `pnpm runtime`).
 */
export class TriageContainer extends Container<Env> {
  defaultPort = 8200;
  /** Heartbeat window; see onActivityExpired — we do not stop. */
  sleepAfter = "24h";
  enableInternet = true;
  // Class field (not getter) — see triageEnvVars doc above.
  envVars = triageEnvVars();

  override onStart(): void {
    console.log(
      `[opentag-agent] triage container started · LINEAR_TEAM_KEY=${this.envVars.LINEAR_TEAM_KEY ?? "unset"} · openai=${this.envVars.OPENAI_API_KEY ? "set" : "MISSING"}`,
    );
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log(
      `[opentag-agent] triage container stopped code=${params.exitCode} reason=${params.reason}`,
    );
  }

  /**
   * Keep the container always-on. Skipping `stop()` renews the activity timer
   * (`@cloudflare/containers` docs). `"never"` is not a valid sleepAfter value.
   */
  override async onActivityExpired(): Promise<void> {
    console.log(
      "[opentag-agent] activity window expired — keeping triage container running",
    );
  }
}
