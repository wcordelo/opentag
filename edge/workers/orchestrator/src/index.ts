/**
 * Orchestrator Worker — Hono router + Durable Object class exports.
 *
 * Gate 0 decisions (DECISIONS.md):
 * - OrchestratorDO keyed by workspace teamId (invariant #6)
 * - /research-only Slack scope; other commands stay on Railway
 * - Events API + slash commands, no Socket Mode
 */
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { OrchestratorDO } from "./OrchestratorDO";
import { ResearcherDO } from "./ResearcherDO";
import { VerifierDO } from "./VerifierDO";
import { slackVerify } from "./slack-verify";
import { handleSlackEvents } from "./slack-events";
import { handleSlackCommands } from "./slack-commands";
import type { AppEnv, CloudflareEnv } from "./env";

export type { AppEnv, CloudflareEnv } from "./env";

const app = new Hono<AppEnv>();

function requireInternalAuth() {
  return async (c: Context<AppEnv>, next: Next) => {
    const secret = c.env.INTERNAL_SECRET;
    if (!secret) {
      if (c.env.ENVIRONMENT === "development") {
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

app.get("/health", (c) =>
  c.json({ ok: true, version: "2.0", env: c.env.ENVIRONMENT }),
);

/**
 * Internal research kickoff (dev / migration tooling).
 * Body: { teamId, threadKey, objective, eventId?, eventTs?, channelId? }
 * Per Gate 0: DO addressed by teamId, not threadKey.
 */
app.post("/research", requireInternalAuth(), async (c) => {
  const body = (await c.req.json()) as {
    teamId: string;
    threadKey: string;
    objective: string;
    eventId?: string;
    eventTs?: string;
    channelId?: string;
  };

  if (!body.teamId || !body.threadKey || !body.objective) {
    return c.json(
      { error: "teamId, threadKey, and objective are required" },
      400,
    );
  }

  const id = c.env.ORCHESTRATOR.idFromName(body.teamId);
  const stub = c.env.ORCHESTRATOR.get(id);
  const res = await stub.fetch(
    new Request("https://do/handleMention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

/**
 * Egress proxy → workspace DO execution log append.
 * Body includes teamId so we can address the correct OrchestratorDO.
 */
app.post("/internal/execution-logs", requireInternalAuth(), async (c) => {
  const body = (await c.req.json()) as {
    teamId: string;
    containerId?: string;
    sessionId?: string;
    host?: string;
    path?: string;
    method?: string;
    status?: number;
    durationMs?: number;
  };

  if (!body.teamId) {
    return c.json({ error: "teamId required" }, 400);
  }

  const id = c.env.ORCHESTRATOR.idFromName(body.teamId);
  const stub = c.env.ORCHESTRATOR.get(id);
  const res = await stub.fetch(
    new Request("https://do/execution-logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

/**
 * Migration import: upsert a TaskRecord into the workspace OrchestratorDO.
 * Body: { teamId, task: TaskRecord }
 */
app.post("/internal/import-task", requireInternalAuth(), async (c) => {
  const body = (await c.req.json()) as {
    teamId: string;
    task: {
      taskId: string;
      threadKey: string;
      status: string;
      objective: string;
      createdAt: string;
      deadlineAt?: string;
      eventTs?: string;
      eventId?: string;
      metadata?: Record<string, unknown>;
    };
  };

  if (!body.teamId || !body.task?.taskId) {
    return c.json({ error: "teamId and task.taskId required" }, 400);
  }

  const id = c.env.ORCHESTRATOR.idFromName(body.teamId);
  const stub = c.env.ORCHESTRATOR.get(id);
  const res = await stub.fetch(
    new Request("https://do/import-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.task),
    }),
  );
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

app.get("/internal/tasks/:taskId", requireInternalAuth(), async (c) => {
  const teamId = c.req.query("teamId");
  const taskId = c.req.param("taskId");
  if (!teamId) return c.json({ error: "teamId query required" }, 400);
  const id = c.env.ORCHESTRATOR.idFromName(teamId);
  const stub = c.env.ORCHESTRATOR.get(id);
  const res = await stub.fetch(new Request(`https://do/tasks/${taskId}`));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/slack/events", slackVerify(), async (c) => {
  return handleSlackEvents(c);
});
app.post("/slack/commands", slackVerify(), async (c) => {
  return handleSlackCommands(c);
});

/** Reserved for Block Kit; stubbed per Gate 0 — no HITL in /research flow. */
app.post("/slack/interactions", slackVerify(), (c) => c.json({ ok: true }, 200));

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("orchestrator worker error", err);
  return c.json(
    { error: "internal_error", message: err.message },
    500,
  );
});

export { OrchestratorDO, ResearcherDO, VerifierDO };

export default {
  fetch: app.fetch,
};
