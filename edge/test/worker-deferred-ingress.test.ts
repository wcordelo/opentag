import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { default: worker } = await import("../src/worker.js");

async function slackSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes.encode(`v0:${timestamp}:${body}`),
  );
  return `v0=${[...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function signedRequest(
  path: string,
  body: string,
  secret: string,
  contentType: string,
): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`https://bot.test${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await slackSignature(secret, timestamp, body),
    },
    body,
  });
}

function makeEnv(prepare: ReturnType<typeof vi.fn>, signingSecret: string): Env {
  const deferredStub = { prepare };
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const botStateStub = {
    kvGet: async (key: string) => values.get(key),
    kvSet: async (key: string, value: unknown) => { values.set(key, value); },
    kvDelete: async (key: string) => { values.delete(key); },
    listAppend: async (
      key: string,
      value: unknown,
      opts?: { maxLen?: number },
    ) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      if (opts?.maxLen && list.length > opts.maxLen) {
        list.splice(0, list.length - opts.maxLen);
      }
      lists.set(key, list);
      return list.length;
    },
    listRange: async (key: string, start = 0, stop = -1) => {
      const list = lists.get(key) ?? [];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return list.slice(start, end);
    },
  };
  return {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_USER_ID: "UOPENTAG",
    DEFERRED_INGRESS: {
      idFromName: (name: string) => ({ name }),
      get: () => deferredStub,
    },
    BOT_STATE: {
      idFromName: (name: string) => ({ name }),
      get: () => botStateStub,
    },
  } as unknown as Env;
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

describe("Slack ingress durable-owner retry boundary", () => {
  it("returns 503 after file-turn alarm ownership fails, then 200 for the identical retry", async () => {
    const signingSecret = "signing-secret";
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error("alarm_write_failed"))
      .mockResolvedValueOnce({ accepted: false, status: "pending" });
    const env = makeEnv(prepare, signingSecret);
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvFileTurnRetry",
      team_id: "T1",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@UOPENTAG> inspect this",
        ts: "1710000000.100000",
        files: [{ id: "F1", name: "evidence.txt" }],
      },
    });

    const first = await worker.request(
      await signedRequest("/slack/events", body, signingSecret, "application/json"),
      undefined,
      env,
      executionContext(),
    );
    const retry = await worker.request(
      await signedRequest("/slack/events", body, signingSecret, "application/json"),
      undefined,
      env,
      executionContext(),
    );

    expect(first.status).toBe(503);
    expect(retry.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
    expect(prepare.mock.calls[0]![0]).toMatchObject({
      id: "file-turn:EvFileTurnRetry",
      kind: "file_turn",
      teamId: "T1",
    });
  });

  it("returns 503 after quick-action alarm ownership fails, then 200 for the identical retry", async () => {
    const signingSecret = "signing-secret";
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error("alarm_write_failed"))
      .mockResolvedValueOnce({ accepted: false, status: "pending" });
    const env = makeEnv(prepare, signingSecret);
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      channel: { id: "C1" },
      user: { id: "U1" },
      message: { ts: "1710000000.200000" },
      actions: [{
        action_id: "quick_retry",
        action_ts: "1710000000.300000",
        value: JSON.stringify({ type: "issue_list" }),
      }],
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();

    const first = await worker.request(
      await signedRequest(
        "/slack/interactions",
        body,
        signingSecret,
        "application/x-www-form-urlencoded",
      ),
      undefined,
      env,
      executionContext(),
    );
    const retry = await worker.request(
      await signedRequest(
        "/slack/interactions",
        body,
        signingSecret,
        "application/x-www-form-urlencoded",
      ),
      undefined,
      env,
      executionContext(),
    );

    expect(first.status).toBe(503);
    expect(retry.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
    expect(prepare.mock.calls[0]![0]).toMatchObject({
      id: "quick:C1:1710000000.200000:1710000000.300000",
      kind: "quick_action",
      teamId: "T1",
    });
  });

  it("retains two same-user pending mentions and routes exact-thread uploads without overwrite", async () => {
    const signingSecret = "signing-secret";
    const prepare = vi.fn(async (_job: unknown) => ({
      accepted: true,
      status: "pending",
    }));
    const env = makeEnv(prepare, signingSecret);
    const mention = async (eventId: string, ts: string) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: eventId,
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@UOPENTAG> inspect the next upload",
          ts,
        },
      });
      return worker.request(
        await signedRequest("/slack/events", body, signingSecret, "application/json"),
        undefined,
        env,
        executionContext(),
      );
    };
    const upload = async (
      eventId: string,
      fileTs: string,
      threadTs: string,
      fileId: string,
    ) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: eventId,
        team_id: "T1",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C1",
          user: "U1",
          ts: fileTs,
          thread_ts: threadTs,
          files: [{ id: fileId, name: `${fileId}.txt` }],
        },
      });
      return worker.request(
        await signedRequest("/slack/events", body, signingSecret, "application/json"),
        undefined,
        env,
        executionContext(),
      );
    };

    expect((await mention("EvMention1", "1710000000.100000")).status).toBe(200);
    expect((await mention("EvMention2", "1710000001.100000")).status).toBe(200);
    expect((await upload(
      "EvUpload2",
      "1710000002.100000",
      "1710000001.100000",
      "F2",
    )).status).toBe(200);
    expect((await upload(
      "EvUpload1",
      "1710000003.100000",
      "1710000000.100000",
      "F1",
    )).status).toBe(200);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        id: expect.stringContaining("EvMention2"),
        kind: "late_file",
        payload: expect.objectContaining({
          pending: expect.objectContaining({ eventId: "EvMention2" }),
        }),
      }),
      expect.objectContaining({
        id: expect.stringContaining("EvMention1"),
        kind: "late_file",
        payload: expect.objectContaining({
          pending: expect.objectContaining({ eventId: "EvMention1" }),
        }),
      }),
    ]);
  });
});
