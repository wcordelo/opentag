import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackWebClient,
  MAX_SLACK_API_RESPONSE_BYTES,
  SlackChannelRateScheduler,
} from "../src/slack/web-api.js";

function mockUsersInfo(profile: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: "U123",
              name: "slack-handle",
              real_name: "Slack Display Name",
              profile: { email: "requester@example.com", ...profile },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack idempotent message responses", () => {
  it("rejects an oversized Slack response before JSON parsing can expand it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{" + "x".repeat(MAX_SLACK_API_RESPONSE_BYTES)));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    )));
    await expect(createSlackWebClient("xoxb-test").authTest()).rejects.toThrow(
      "slack_api_response_too_large",
    );
  });

  it("observes bot posts and final updates without sending local metadata to Slack", async () => {
    const observations: unknown[] = [];
    const bodies: Array<{ method: string; body: URLSearchParams }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({
        method: String(url).split("/").pop()!,
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return String(url).endsWith("chat.postMessage")
        ? Response.json({ ok: true, ts: "171234.000200" })
        : Response.json({ ok: true });
    }));
    const client = createSlackWebClient("xoxb-test", {
      messageObserver: async (observation) => {
        observations.push(observation);
      },
    });

    await client.postMessage({
      channel: "C1",
      thread_ts: "171234.000100",
      text: "bot reply",
      knowledgeIndex: true,
      knowledgeTeamId: "T1",
    });
    await client.updateMessage({
      channel: "C1",
      ts: "171234.000200",
      thread_ts: "171234.000100",
      text: "final bot reply",
      knowledgeIndex: true,
      knowledgeTeamId: "T1",
    });
    await client.updateMessage({
      channel: "C1",
      ts: "171234.000200",
      thread_ts: "171234.000100",
      text: "transient bot reply",
    });

    expect(observations).toEqual([
      expect.objectContaining({
        operation: "posted",
        channel: "C1",
        ts: "171234.000200",
        threadTs: "171234.000100",
        text: "bot reply",
      }),
      expect.objectContaining({
        operation: "updated",
        channel: "C1",
        ts: "171234.000200",
        threadTs: "171234.000100",
        text: "final bot reply",
      }),
      expect.objectContaining({
        operation: "updated",
        channel: "C1",
        ts: "171234.000200",
        text: "transient bot reply",
      }),
    ]);
    expect(bodies[0]!.body.get("knowledgeIndex")).toBeNull();
    expect(bodies[0]!.body.get("knowledgeTeamId")).toBeNull();
    expect(bodies[1]!.body.get("thread_ts")).toBeNull();
    expect(bodies[1]!.body.get("knowledgeIndex")).toBeNull();
    expect(bodies[1]!.body.get("knowledgeTeamId")).toBeNull();
  });

  it("observes every committed write unless explicitly suppressed", async () => {
    const observations: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("chat.postMessage")
        ? Response.json({ ok: true, ts: "171234.000201" })
        : Response.json({ ok: true }),
    ));
    const client = createSlackWebClient("xoxb-test", {
      messageObserver: (observation) => { observations.push(observation); },
    });
    await client.postMessage({ channel: "C1", text: "placeholder" });
    await client.postMessage({ channel: "C1", text: "final", knowledgeIndex: true });
    await client.postMessage({ channel: "C1", text: "deliberately transient", knowledgeIndex: false });
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => (observation as { text: string }).text))
      .toEqual(["placeholder", "final"]);
  });

  it("hydrates delayed uploads with form-encoded files.info", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      calls.push(String(init?.body));
      return Response.json({
        ok: true,
        file: { id: "F1", mimetype: "application/pdf", size: 12, url_private: "https://files.slack.com/F1" },
      });
    }));
    await expect(createSlackWebClient("xoxb-test").getFileInfo("F1"))
      .resolves.toMatchObject({ id: "F1", mimetype: "application/pdf", size: 12 });
    expect(calls).toEqual(["file=F1"]);
  });

  it("reads every channel member across bounded conversations.members pages", async () => {
    const requests: string[] = [];
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body ?? ""));
      page += 1;
      return page === 1
        ? Response.json({
            ok: true,
            members: ["U2", "U1"],
            response_metadata: { next_cursor: "next-page" },
          })
        : Response.json({ ok: true, members: ["U2", "U3"] });
    }));

    await expect(createSlackWebClient("xoxb-test").getChannelMembers({
      channel: "C1",
      pageSize: 2,
    })).resolves.toEqual(["U1", "U2", "U3"]);
    expect(requests).toEqual([
      "channel=C1&limit=2",
      "channel=C1&limit=2&cursor=next-page",
    ]);
  });

  it("lists mixed Slack conversations with server-owned pagination", async () => {
    const requests: URLSearchParams[] = [];
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URLSearchParams(String(init?.body ?? "")));
      page += 1;
      return page === 1
        ? Response.json({
            ok: true,
            channels: [
              { id: "C1", is_member: true, is_archived: false, is_im: false, is_mpim: false },
              { id: "D1", is_member: true, is_im: true },
            ],
            response_metadata: { next_cursor: "next-page" },
          })
        : Response.json({
            ok: true,
            channels: [{ id: "G1", is_member: false, is_mpim: true }],
            response_metadata: { next_cursor: "" },
          });
    }));

    const client = createSlackWebClient("xoxb-test");
    await expect(client.listConversations({ pageSize: 2 })).resolves.toEqual({
      conversations: [
        { id: "C1", isArchived: false, isMember: true, isIm: false, isMpim: false },
        { id: "D1", isMember: true, isIm: true },
      ],
      nextCursor: "next-page",
    });
    await expect(client.listConversations({ pageSize: 2, cursor: "next-page" }))
      .resolves.toEqual({
        conversations: [{ id: "G1", isMember: false, isMpim: true }],
      });
    expect(requests[0]?.get("types")).toBe("public_channel,private_channel,im,mpim");
    expect(requests[0]?.get("exclude_archived")).toBe("false");
    expect(requests[1]?.get("cursor")).toBe("next-page");
  });

  it("looks up a message parent thread from its exact timestamp", async () => {
    const requests: URLSearchParams[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({
        ok: true,
        messages: [{ ts: "171234.000199", thread_ts: "171000.000001" }],
      });
    }));
    await expect(createSlackWebClient("xoxb-test").getMessageByTimestamp({
      channel: "C1",
      timestamp: "171234.000199",
    })).resolves.toEqual({
      found: true,
      message: { ts: "171234.000199", thread_ts: "171000.000001" },
    });
    expect(requests[0]?.get("latest")).toBe("171234.000199");
    expect(requests[0]?.get("inclusive")).toBe("true");
    expect(requests[0]?.get("limit")).toBe("1");
  });

  it("reconciles an ambiguous placeholder by exact client_msg_id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      messages: [
        { ts: "1.1", client_msg_id: "other" },
        { ts: "1.2", client_msg_id: "live-exact" },
      ],
    })));
    await expect(createSlackWebClient("xoxb-test").findMessageByClientMessageId({
      channel: "C1",
      threadTs: "1.0",
      clientMessageId: "live-exact",
    })).resolves.toEqual({ found: true, ts: "1.2" });
  });

  it("honors Retry-After and retries HTTP 429 with the identical form body", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      calls.push(String(init?.body));
      return calls.length === 1
        ? Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": "2" } },
          )
        : Response.json({ ok: true, ts: "1.0" });
    }));
    await expect(createSlackWebClient("xoxb-test", { sleep }).postMessage({
      channel: "C-rate",
      text: "hello",
      client_msg_id: "11111111-1111-5111-8111-111111111111",
    })).resolves.toMatchObject({ ok: true, ts: "1.0" });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("reserves a shared channel slot for every bot HTTP retry attempt", async () => {
    const schedulerRun = vi.fn(
      async (_channel: string, operation: () => Promise<unknown>) =>
        operation(),
    );
    const scheduler = {
      run<T>(channel: string, operation: () => Promise<T>): Promise<T> {
        return schedulerRun(channel, operation) as Promise<T>;
      },
    };
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "0" } },
      ))
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "1.0" })));
    await createSlackWebClient("xoxb-test", { scheduler, sleep }).postMessage({
      channel: "C-shared",
      text: "hello",
    });
    expect(schedulerRun).toHaveBeenCalledTimes(2);
    expect(schedulerRun).toHaveBeenNthCalledWith(
      1,
      "C-shared",
      expect.any(Function),
    );
    expect(schedulerRun).toHaveBeenNthCalledWith(
      2,
      "C-shared",
      expect.any(Function),
    );
  });

  it("serializes and spaces writes sharing a channel while allowing other channels", async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = new SlackChannelRateScheduler(
      1_000,
      () => now,
      async (ms) => { waits.push(ms); now += ms; },
    );
    const order: string[] = [];
    await Promise.all([
      scheduler.run("C1", async () => { order.push("C1:first"); }),
      scheduler.run("C1", async () => { order.push("C1:second"); }),
      scheduler.run("C2", async () => { order.push("C2:first"); }),
    ]);
    expect(order.indexOf("C1:first")).toBeLessThan(order.indexOf("C1:second"));
    expect(waits).toContain(1_000);
  });

  it("preempts a queued local write before a control write", async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = new SlackChannelRateScheduler(
      1_000,
      () => now,
      async (ms) => { waits.push(ms); now += ms; },
    );
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const first = scheduler.run("C-control", async () => {
      entered();
      return active;
    });
    await enteredPromise;
    const queued = scheduler.run("C-control", async () => "queued");
    await scheduler.preempt("C-control");
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).rejects.toMatchObject({ message: "slack_egress_preempted" });
    await expect(scheduler.run("C-control", async () => "control", "control"))
      .resolves.toBe("control");
    expect(waits).toEqual([]);
  });

  it("passes control priority through the Slack client scheduler", async () => {
    const schedulerRun = vi.fn(
      async (
        _channel: string,
        operation: () => Promise<unknown>,
        _priority?: "normal" | "control",
      ) => operation(),
    );
    const scheduler = {
      run<T>(
        channel: string,
        operation: () => Promise<T>,
        priority?: "normal" | "control",
      ): Promise<T> {
        return schedulerRun(channel, operation, priority) as Promise<T>;
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ts: "1.0" })));
    await createSlackWebClient("xoxb-test", {
      scheduler,
      priority: "control",
    }).postMessage({ channel: "C-control", text: "stop" });
    expect(schedulerRun).toHaveBeenCalledWith(
      "C-control",
      expect.any(Function),
      "control",
    );
  });

  it.each(["duplicate_message", "duplicate_client_msg_id"])(
    "treats %s as an already-visible client_msg_id write",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ok: false, error })),
      );
      await expect(createSlackWebClient("xoxb-test").postMessage({
        channel: "C1",
        text: "stopped",
        client_msg_id: "11111111-1111-5111-8111-111111111111",
      })).resolves.toMatchObject({ ok: true, duplicate: true, error });
    },
  );

  it("recovers outbound indexing after an idempotent duplicate without a timestamp", async () => {
    const observations: unknown[] = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      call += 1;
      if (String(url).endsWith("chat.postMessage")) {
        return Response.json({ ok: false, error: "duplicate_message" });
      }
      return Response.json({
        ok: true,
        messages: [{ ts: "1.2", client_msg_id: "stable-stop" }],
      });
    }));
    const client = createSlackWebClient("xoxb-test", {
      messageObserver: (observation) => { observations.push(observation); },
    });
    await client.postMessage({
      channel: "C1",
      thread_ts: "1.0",
      text: "stopped",
      client_msg_id: "stable-stop",
      knowledgeIndex: true,
      knowledgeTeamId: "T1",
    });
    expect(call).toBe(2);
    expect(observations).toEqual([
      expect.objectContaining({ operation: "posted", ts: "1.2", teamId: "T1" }),
    ]);
  });

  it("does not claim an indexed duplicate when Slack lookup cannot recover its timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("chat.postMessage")) {
        return Response.json({ ok: false, error: "duplicate_message" });
      }
      return Response.json({ ok: true, messages: [] });
    }));
    const client = createSlackWebClient("xoxb-test", {
      messageObserver: () => undefined,
    });
    await expect(client.postMessage({
      channel: "C1",
      text: "stopped",
      client_msg_id: "stable-stop",
    })).rejects.toThrow("duplicate_message_timestamp_unavailable");
  });

  it("does not silently complete an observed post without a Slack timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const client = createSlackWebClient("xoxb-test", {
      messageObserver: () => undefined,
    });
    await expect(client.postMessage({
      channel: "C1",
      text: "reply",
    })).rejects.toThrow("chat.postMessage_timestamp_missing");
  });

  it("fails before an indexed post when durable observation is required but unbound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createSlackWebClient("xoxb-test", {
      messageObserverRequired: true,
    });
    await expect(client.postMessage({
      channel: "C1",
      text: "reply",
    })).rejects.toThrow("knowledge_observer_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before an indexed update when durable observation is required but unbound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createSlackWebClient("xoxb-test", {
      messageObserverRequired: true,
    });
    await expect(client.updateMessage({
      channel: "C1",
      ts: "171234.000100",
      text: "updated",
    })).rejects.toThrow("knowledge_observer_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves an ok response even when Slack omits the timestamp on a replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(createSlackWebClient("xoxb-test").postMessage({
      channel: "C1",
      text: "stopped",
      client_msg_id: "11111111-1111-5111-8111-111111111111",
    })).resolves.toEqual({ ok: true, ts: undefined, error: undefined });
  });
});

describe("Slack requester GitHub profile extraction", () => {
  it("uses users.profile.get with include_labels for named custom fields", async () => {
    const calls: Array<{ method: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: String(url).split("/").pop()!, body: String(init?.body ?? "") });
      if (String(url).endsWith("users.profile.get")) {
        return Response.json({ ok: true, profile: { fields: { X1: { label: "GitHub", value: "profile-user" } } } });
      }
      return Response.json({ ok: true, user: { id: "U123", name: "slack-user", profile: { email: "u@example.com" } } });
    }));
    const user = await createSlackWebClient("xoxb").resolveUser("U123") as { githubHandle?: string };
    expect(user.githubHandle).toBe("profile-user");
    expect(calls).toContainEqual({ method: "users.profile.get", body: "user=U123&include_labels=true" });
  });
  it("uses display_name instead of a divergent real name", async () => {
    mockUsersInfo({
      display_name: "Preferred Display",
      real_name: "Legal Real Name",
    });

    const user = await createSlackWebClient("xoxb-test").resolveUser("U123");
    expect(user.name).toBe("Preferred Display");
  });

  it("falls back from a blank display_name to the profile real name", async () => {
    mockUsersInfo({ display_name: "", real_name: "Profile Real Name" });
    const user = await createSlackWebClient("xoxb-test").resolveUser("U123");
    expect(user.name).toBe("Profile Real Name");
  });

  it.each([
    [
      "github_url URL",
      { fields: { github_url: { value: "https://github.com/url-user" } } },
      "url-user",
    ],
    [
      "github @handle",
      { fields: { github: { value: "@at-user" } } },
      "at-user",
    ],
    ["github plain handle", { github: "plain-user" }, "plain-user"],
    [
      "custom field label",
      { fields: { Xf0123: { label: "GitHub", value: "label-user" } } },
      "label-user",
    ],
    [
      "custom field name",
      { fields: { Xf0456: { name: "github_url", value: "https://github.com/name-user" } } },
      "name-user",
    ],
  ])("supports %s", async (_label, profile, expected) => {
    mockUsersInfo(profile);

    const user = (await createSlackWebClient("xoxb-test").resolveUser(
      "U123",
    )) as {
      githubHandle?: string;
    };

    expect(user.githubHandle).toBe(expected);
  });

  it.each(["status text", "unrelated custom field"])(
    "does not accept github.com URLs from %s",
    async (source) => {
    mockUsersInfo({
      status_text:
        source === "status text" ? "https://github.com/status-spoof" : "",
      fields: {
        Xf0123: {
          value:
            source === "unrelated custom field"
              ? "My code lives at https://github.com/custom-field-spoof/projects"
              : "not github",
        },
      },
    });

    const user = (await createSlackWebClient("xoxb-test").resolveUser(
      "U123",
    )) as {
      githubHandle?: string;
    };

    expect(user.githubHandle).toBeUndefined();
  });
});
