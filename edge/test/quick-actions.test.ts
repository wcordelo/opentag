/**
 * Phase A4 — quick-action cards: URL scanning, card rendering (action_id +
 * value round-trip), payload decoding, and synthetic-turn routing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderBlockKit } from "@copilotkit/channels-slack/render";
import { renderToIR } from "@copilotkit/channels-ui";
import {
  findQuickSiteUrls,
  buildQuickDeployCard,
  buildQuickDeployCardFromRefs,
  quickActionId,
  MAX_QUICK_CARD_ARTIFACTS,
} from "../src/slack/quick-card.js";
import { IssueList } from "../src/components/cards.js";

const onTurn = vi.fn(async (_turn: unknown) => {});
vi.mock("../src/bot-engine.js", () => ({
  getOrCreateBot: vi.fn(async () => ({
    adapter: { getSink: () => ({ onTurn }) },
  })),
}));

const {
  parseQuickAction,
  parseQuickActionKind,
  parseQuickRef,
  buildQuickActionPrompt,
  isQuickInteraction,
  handleQuickAction,
} = await import("../src/slack/quick-actions.js");

type Block = {
  type: string;
  elements?: Array<{ action_id?: string; value?: string; text?: unknown }>;
};

function blocksOf(node: unknown): Block[] {
  // Function components (Message, Section, …) are expanded to intrinsic IR by
  // the framework before the Block Kit renderer runs — mirror that here.
  const ir = renderToIR(node as never);
  const msg = renderBlockKit(ir) as { blocks?: Block[] } | Block[];
  return Array.isArray(msg) ? msg : (msg.blocks ?? []);
}

describe("findQuickSiteUrls", () => {
  it("finds and dedups artifact URLs on the base domain", () => {
    const text =
      "Done: https://report-1.artifacts.opentag.dev/index.html and " +
      "again https://report-1.artifacts.opentag.dev plus " +
      "https://other.artifacts.opentag.dev — but not https://x.evil.dev";
    const refs = findQuickSiteUrls(text, "artifacts.opentag.dev");
    expect(refs).toEqual([
      {
        type: "artifact",
        artifactId: "report-1",
        url: "https://report-1.artifacts.opentag.dev",
      },
      {
        type: "artifact",
        artifactId: "other",
        url: "https://other.artifacts.opentag.dev",
      },
    ]);
  });

  it("rejects lookalike domains and empty input", () => {
    expect(
      findQuickSiteUrls(
        "https://a.artifacts.opentag.dev.evil.com",
        "artifacts.opentag.dev",
      ),
    ).toEqual([]);
    expect(findQuickSiteUrls("", "artifacts.opentag.dev")).toEqual([]);
    expect(findQuickSiteUrls("text", "")).toEqual([]);
  });
});

describe("buildQuickDeployCard", () => {
  it("renders quick_* action_ids with JSON ref values that round-trip", () => {
    const card = buildQuickDeployCard(
      "See https://site-a.artifacts.opentag.dev",
      "artifacts.opentag.dev",
    );
    expect(card).not.toBeNull();
    const blocks = blocksOf(card);
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const ids = (actions?.elements ?? []).map((e) => e.action_id);
    expect(ids).toEqual([
      quickActionId("regenerate"),
      quickActionId("files"),
      quickActionId("delete"),
    ]);
    for (const el of actions?.elements ?? []) {
      expect(el.value!.length).toBeLessThanOrEqual(2000);
      const ref = parseQuickRef(el.value);
      expect(ref).toEqual({
        type: "artifact",
        artifactId: "site-a",
        url: "https://site-a.artifacts.opentag.dev",
      });
    }
  });

  it("returns null with no matching URLs", () => {
    expect(buildQuickDeployCard("nothing here", "artifacts.opentag.dev")).toBeNull();
  });

  it("caps at the 50-block limit and reports omissions", () => {
    const refs = Array.from({ length: 40 }, (_, i) => ({
      type: "artifact" as const,
      artifactId: `site-${i}`,
      url: `https://site-${i}.a.dev`,
    }));
    const blocks = blocksOf(buildQuickDeployCardFromRefs(refs));
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(refs.length).toBeGreaterThan(MAX_QUICK_CARD_ARTIFACTS);
    const flat = JSON.stringify(blocks);
    expect(flat).toContain("not shown");
  });
});

describe("IssueList retry button", () => {
  it("carries a quick_retry action with an issue_list ref", () => {
    const blocks = blocksOf(
      IssueList({
        heading: "My open bugs",
        issues: [{ identifier: "BER-1", title: "Bug" }],
      }),
    );
    const actions = blocks.find((b) => b.type === "actions");
    const btn = actions?.elements?.[0];
    expect(btn?.action_id).toBe("quick_retry");
    expect(parseQuickRef(btn?.value)).toEqual({
      type: "issue_list",
      heading: "My open bugs",
    });
  });
});

describe("parsing", () => {
  it("parseQuickActionKind accepts known kinds only, with prefix", () => {
    expect(parseQuickActionKind("quick_retry")).toBe("retry");
    expect(parseQuickActionKind("quick_regenerate")).toBe("regenerate");
    expect(parseQuickActionKind("quick_nope")).toBeNull();
    expect(parseQuickActionKind("ck:abc")).toBeNull();
  });

  it("parseQuickRef rejects malformed JSON and wrong shapes", () => {
    expect(parseQuickRef("{not json")).toBeNull();
    expect(parseQuickRef(undefined)).toBeNull();
    expect(parseQuickRef('{"type":"artifact"}')).toBeNull();
    expect(parseQuickRef('{"type":"issue_list"}')).toEqual({
      type: "issue_list",
    });
  });

  it("buildQuickActionPrompt references the ref", () => {
    const prompt = buildQuickActionPrompt({
      kind: "regenerate",
      ref: { type: "artifact", artifactId: "s1", url: "https://s1.a.dev" },
    });
    expect(prompt).toContain("s1");
    expect(prompt).toContain("https://s1.a.dev");
    const retry = buildQuickActionPrompt({
      kind: "retry",
      ref: { type: "issue_list", heading: "Open bugs" },
    });
    expect(retry).toContain("Open bugs");
  });
});

describe("handleQuickAction", () => {
  beforeEach(() => {
    onTurn.mockClear();
  });

  const payload = (over: Record<string, unknown> = {}) => ({
    type: "block_actions",
    trigger_id: "trig1",
    user: { id: "UCLICK" },
    channel: { id: "C1" },
    message: { ts: "10.0", thread_ts: "9.0" },
    actions: [
      {
        action_id: "quick_retry",
        value: JSON.stringify({ type: "issue_list", heading: "Bugs" }),
        action_ts: "11.1",
      },
    ],
    ...over,
  });

  it("isQuickInteraction routes quick_* only", () => {
    expect(isQuickInteraction(payload())).toBe(true);
    expect(
      isQuickInteraction(
        payload({ actions: [{ action_id: "ck:abc", value: "{}" }] }),
      ),
    ).toBe(false);
    expect(isQuickInteraction({ type: "view_submission" })).toBe(false);
  });

  it("routes a synthetic turn authored by the clicking user", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        user: { id: "UCLICK", real_name: "Click Er", name: "clicker" },
      })) as typeof fetch;
    try {
      const r = await handleQuickAction(
        { SLACK_BOT_TOKEN: "xoxb-test" } as never,
        payload(),
      );
      expect(r.handled).toBe(true);
      expect(onTurn).toHaveBeenCalledTimes(1);
      const turn = onTurn.mock.calls[0]![0] as {
        conversationKey: string;
        userText: string;
        user?: { id: string; name?: string };
        eventId?: string;
      };
      expect(turn.conversationKey).toBe("C1::9.0");
      expect(turn.userText).toContain("Bugs");
      expect(turn.user?.id).toBe("UCLICK");
      expect(turn.eventId).toBe("quick:C1:10.0:11.1");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("bad JSON value → handled:false, no turn", async () => {
    const r = await handleQuickAction(
      { SLACK_BOT_TOKEN: "xoxb-test" } as never,
      payload({
        actions: [{ action_id: "quick_retry", value: "{broken", action_ts: "1.1" }],
      }),
    );
    expect(r.handled).toBe(false);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("missing channel/user → handled:false", async () => {
    const r = await handleQuickAction(
      { SLACK_BOT_TOKEN: "xoxb-test" } as never,
      payload({ channel: undefined }),
    );
    expect(r.handled).toBe(false);
    expect(onTurn).not.toHaveBeenCalled();
  });
});
