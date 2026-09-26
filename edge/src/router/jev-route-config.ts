import type { Env } from "../env.js";
import {
  ROUTER_JEV_MODEL_DEFAULT,
  ROUTER_JEV_TIMEOUT_MS_DEFAULT,
} from "./jev-route-questions.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isRouterJevShadowEnabled(env: Pick<Env, "ROUTER_JEV_SHADOW">): boolean {
  return env.ROUTER_JEV_SHADOW?.trim().toLowerCase() === "on";
}

export function resolveRouterJevShadowConfig(env: Pick<
  Env,
  "ROUTER_JEV_SHADOW" | "TYPESAFE_API_KEY" | "ROUTER_JEV_MODEL" | "ROUTER_JEV_TIMEOUT_MS"
>): {
  enabled: boolean;
  apiKey?: string;
  model: string;
  timeoutMs: number;
} {
  const enabled = isRouterJevShadowEnabled(env);
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  return {
    enabled,
    ...(enabled && apiKey ? { apiKey } : {}),
    model: env.ROUTER_JEV_MODEL?.trim() || ROUTER_JEV_MODEL_DEFAULT,
    timeoutMs: Math.min(
      1_500,
      parsePositiveInt(env.ROUTER_JEV_TIMEOUT_MS, ROUTER_JEV_TIMEOUT_MS_DEFAULT),
    ),
  };
}
