import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tenantStub } from "../src/tenancy.js";

describe("KnowledgeDO Slack ACL invalidation", () => {
  it("deduplicates membership events and exposes a durable stale-to-fresh transition", async () => {
    const teamId = `acl-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const invalidation = {
      teamId,
      channelId: "C1",
      eventId: "Ev-member-1",
      eventType: "member_left_channel",
      userId: "U2",
      observedAt: "2026-08-01T23:00:00.000Z",
    };

    const first = await stub.fetch("https://do/acl/invalidate", {
      method: "POST",
      body: JSON.stringify(invalidation),
    });
    expect(first.ok).toBe(true);
    expect(await first.json()).toMatchObject({ invalidated: true, duplicate: false, revision: 1 });

    const duplicate = await stub.fetch("https://do/acl/invalidate", {
      method: "POST",
      body: JSON.stringify(invalidation),
    });
    expect(await duplicate.json()).toMatchObject({ invalidated: false, duplicate: true });

    const stale = await stub.fetch("https://do/acl/state", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    });
    expect(await stale.json()).toMatchObject({
      team_id: teamId,
      channel_id: "C1",
      status: "stale",
      revision: 1,
      last_event_id: "Ev-member-1",
      last_user_id: "U2",
    });

    const refresh = await stub.fetch("https://do/acl/refresh", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        memberIds: ["U1", "U2"],
        expectedRevision: 1,
      }),
    });
    expect(await refresh.json()).toMatchObject({
      refreshed: true,
      revision: 1,
      membershipDigest: expect.stringMatching(/^sha256:/),
    });

    const fresh = await stub.fetch("https://do/acl/state", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    });
    expect(await fresh.json()).toMatchObject({
      status: "fresh",
      revision: 1,
      membership_digest: expect.stringMatching(/^sha256:/),
      memberIds: ["U1", "U2"],
      refreshedAt: expect.any(Number),
    });

    const authorize = await stub.fetch("https://do/acl/authorize", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", actorId: "U1" }),
    });
    expect(authorize.ok).toBe(true);
    const lease = await authorize.json() as { leaseId: string; revision: number };
    expect(lease).toMatchObject({ leaseId: expect.any(String), revision: 1 });

    const check = await stub.fetch("https://do/acl/check", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", actorId: "U1", leaseId: lease.leaseId }),
    });
    expect(await check.json()).toEqual({ authorized: true });

    const secondInvalidation = await stub.fetch("https://do/acl/invalidate", {
      method: "POST",
      body: JSON.stringify({
        ...invalidation,
        eventId: "Ev-member-2",
        eventType: "member_left_channel",
      }),
    });
    expect(secondInvalidation.ok).toBe(true);
    const revoked = await stub.fetch("https://do/acl/check", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", actorId: "U1", leaseId: lease.leaseId }),
    });
    expect(revoked.status).toBe(403);
  });

  it("rejects a refresh fetched before a newer invalidation", async () => {
    const teamId = `acl-race-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const invalidate = async (eventId: string) => stub.fetch("https://do/acl/invalidate", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", eventId, eventType: "member_left_channel" }),
    });

    await invalidate("Ev-member-1");
    await invalidate("Ev-member-2");
    const refresh = await stub.fetch("https://do/acl/refresh", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        memberIds: ["U1"],
        expectedRevision: 1,
      }),
    });
    expect(refresh.status).toBe(409);
    expect(await refresh.json()).toMatchObject({ refreshed: false, conflict: true, revision: 2 });

    const state = await stub.fetch("https://do/acl/state", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    });
    expect(await state.json()).toMatchObject({ status: "stale", revision: 2 });
  });

  it("denies an ACL snapshot after its maximum age", async () => {
    const teamId = `acl-old-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const refresh = await stub.fetch("https://do/acl/refresh", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        memberIds: ["U1"],
        expectedRevision: 0,
        refreshedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
    });
    expect(refresh.ok).toBe(true);
    const authorize = await stub.fetch("https://do/acl/authorize", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", actorId: "U1" }),
    });
    expect(authorize.status).toBe(403);
  });
});
