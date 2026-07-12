/**
 * Admin / internal route auth for the bot Worker.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";

/** Require `Authorization: Bearer $ADMIN_SECRET` (dev allows missing secret). */
export function requireAdminAuth(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const secret = c.env.ADMIN_SECRET;
    if (!secret) {
      if (c.env.ENVIRONMENT === "development" || c.env.ENVIRONMENT === "test") {
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
