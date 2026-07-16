import { describe, expect, it } from "vitest";
import {
  bindRequestContext,
  copyRequestContext,
  requireRequestContext,
  resetRequestContext,
  slackTurnIdentity,
} from "../src/request-context.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("request-context", () => {
  it("keeps overlapping same-channel Slack turns fully isolated", async () => {
    resetRequestContext();
    const userA = { id: "U-A" };
    const userB = { id: "U-B" };
    const threadA = {};
    const threadB = {};
    const aBound = deferred();
    const bBound = deferred();

    const runA = (async () => {
      bindRequestContext(userA, {
        teamId: "T-A",
        requesterId: "U-A",
        inbound: { channel: "C-SAME", ts: "100.001", threadTs: "100.000" },
      });
      copyRequestContext(userA, threadA);
      aBound.resolve();
      await bBound.promise;
      const context = requireRequestContext(threadA);
      return {
        ...context,
        ...await slackTurnIdentity(context, "C-SAME"),
      };
    })();

    const runB = (async () => {
      await aBound.promise;
      bindRequestContext(userB, {
        teamId: "T-B",
        requesterId: "U-B",
        inbound: { channel: "C-SAME", ts: "100.002", threadTs: "100.000" },
      });
      copyRequestContext(userB, threadB);
      bBound.resolve();
      await Promise.resolve();
      const context = requireRequestContext(threadB);
      return {
        ...context,
        ...await slackTurnIdentity(context, "C-SAME"),
      };
    })();

    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toMatchObject({
      teamId: "T-A",
      actor: { kind: "slack_user", userId: "U-A" },
      requesterId: "U-A",
      inbound: { channel: "C-SAME", ts: "100.001", threadTs: "100.000" },
    });
    expect(b).toMatchObject({
      teamId: "T-B",
      requesterId: "U-B",
      inbound: { channel: "C-SAME", ts: "100.002", threadTs: "100.000" },
    });
    expect(a.executionId).toMatch(/^ot1e_[A-Za-z0-9_-]{43}$/);
    expect(a.forwardedMessageId).toMatch(/^ot1m_[A-Za-z0-9_-]{43}$/);
    expect(a.executionId).not.toBe(a.forwardedMessageId);
    expect(b.executionId).not.toBe(a.executionId);
    expect(b.forwardedMessageId).not.toBe(a.forwardedMessageId);
  });

  it("copies one immutable context object onto the concrete thread", () => {
    resetRequestContext();
    const user = {};
    const thread = {};
    const bound = bindRequestContext(user, {
      teamId: "T1",
      requesterId: "U1",
      inbound: { channel: "C1", ts: "1.2" },
    });
    expect(copyRequestContext(user, thread)).toBe(bound);
    expect(Object.isFrozen(requireRequestContext(thread))).toBe(true);
    expect(Object.isFrozen(requireRequestContext(thread).inbound)).toBe(true);
    expect(Object.isFrozen(requireRequestContext(thread).actor)).toBe(true);
  });

  it("uses bounded non-human compatibility labels without changing wire identity inputs", async () => {
    const context = bindRequestContext({}, {
      teamId: "T1",
      actor: {
        kind: "slack_automation",
        botId: "B1",
        appId: "A1",
        displayName: "Alert bot",
      },
      inbound: { channel: "C1", ts: "1.2", identity: "Ev1" },
    });
    expect(context).toMatchObject({
      actor: { kind: "slack_automation", botId: "B1", appId: "A1" },
      requesterId: "app:A1",
    });
    await expect(slackTurnIdentity(context, "C1")).resolves.toMatchObject({
      executionId: expect.stringMatching(/^ot1e_/),
    });
  });

  it("rejects a context bound to a foreign channel", async () => {
    const user = {};
    const context = bindRequestContext(user, {
      teamId: "T1",
      requesterId: "U1",
      inbound: { channel: "C-FOREIGN", ts: "1.2" },
    });
    await expect(slackTurnIdentity(context, "C-EXPECTED")).rejects.toThrow(
      /channel does not match/,
    );
  });

  it("is stable, collision-safe, Unicode-safe, and bounded for maximum source inputs", async () => {
    const context = bindRequestContext({}, {
      teamId: "T:équipe/東京",
      requesterId: "U1",
      inbound: {
        channel: "C:" + "界".repeat(255),
        threadTs: "9".repeat(255),
        ts: "1712345678.000001",
      },
    });
    const channel = context.inbound!.channel;
    const first = await slackTurnIdentity(context, channel);
    const repeated = await slackTurnIdentity(context, channel);
    expect(repeated).toEqual(first);
    expect(first.executionId).toHaveLength(48);
    expect(first.forwardedMessageId).toHaveLength(48);

    const boundaryA = await slackTurnIdentity(bindRequestContext({}, {
      teamId: "T", requesterId: "U", inbound: { channel: "a:b", threadTs: "c", ts: "d" },
    }), "a:b");
    const boundaryB = await slackTurnIdentity(bindRequestContext({}, {
      teamId: "T", requesterId: "U", inbound: { channel: "a", threadTs: "b:c", ts: "d" },
    }), "a");
    expect(boundaryA).not.toEqual(boundaryB);

    const clickA = await slackTurnIdentity(bindRequestContext({}, {
      teamId: "T", requesterId: "U", inbound: {
        channel: "C", threadTs: "1.0", ts: "1.1", identity: "quick:C:1.1:2.001",
      },
    }), "C");
    const clickB = await slackTurnIdentity(bindRequestContext({}, {
      teamId: "T", requesterId: "U", inbound: {
        channel: "C", threadTs: "1.0", ts: "1.1", identity: "quick:C:1.1:2.002",
      },
    }), "C");
    expect(clickA).not.toEqual(clickB);
  });
});
