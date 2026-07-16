import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackWebClient,
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
