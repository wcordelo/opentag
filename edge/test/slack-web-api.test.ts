import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackWebClient } from "../src/slack/web-api.js";

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
