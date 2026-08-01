import { describe, expect, it } from "vitest";
import {
  mintKnowledgeActorToken,
  verifyKnowledgeActorToken,
} from "../src/mcp/knowledge-actor-token.js";

function claims(nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1_000);
  return {
    jti: crypto.randomUUID(),
    teamId: "T1",
    projectId: "P1",
    actor: { kind: "slack_user" as const, id: "U1" },
    aclPolicyRef: "bundle:default",
    scopes: {
      channelIds: ["C1"],
      spaceIds: [],
      repoIds: [],
      connectorIds: [],
    },
    iat: issuedAt,
    exp: issuedAt + 240,
  };
}

describe("knowledge actor tokens", () => {
  it("round trips a bounded actor claim set", async () => {
    const token = await mintKnowledgeActorToken("secret", claims());
    const result = await verifyKnowledgeActorToken(token, "secret");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.teamId).toBe("T1");
      expect(result.claims.scopes.channelIds).toEqual(["C1"]);
    }
  });

  it("rejects tampering and a different secret", async () => {
    const token = await mintKnowledgeActorToken("secret", claims());
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]!.replace(/.$/, "A")}.${parts[2]}`;
    await expect(verifyKnowledgeActorToken(tampered, "secret")).resolves.toMatchObject({ ok: false });
    await expect(verifyKnowledgeActorToken(token, "other-secret")).resolves.toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("rejects expired, future, and overlong claims", async () => {
    const now = Date.now();
    const expired = claims(now - 240_000);
    expired.exp = Math.floor(now / 1_000) - 1;
    const expiredToken = await mintKnowledgeActorToken("secret", expired);
    await expect(verifyKnowledgeActorToken(expiredToken, "secret", now)).resolves.toMatchObject({ ok: false, code: "expired" });

    const future = claims(now + 10 * 60_000);
    const futureToken = await mintKnowledgeActorToken("secret", future);
    await expect(verifyKnowledgeActorToken(futureToken, "secret", now)).resolves.toMatchObject({ ok: false, code: "not_yet_valid" });

    await expect(mintKnowledgeActorToken("secret", { ...claims(), exp: claims().iat + 301 })).rejects.toThrow("invalid knowledge actor token claims");
  });
});
