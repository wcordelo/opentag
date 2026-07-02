import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createDurableObjectStore } from "../src/store/index.js";
import { runStateStoreConformance } from "./conformance.js";

/**
 * TRUE end-to-end: the full @copilotkit/bot StateStore conformance suite run
 * against the real Durable Object in workerd — RPC (getByName) → DO →
 * ctx.storage.sql → transactionSync. Each `make()` targets a fresh DO instance
 * (unique partition) so tests are isolated, mirroring the reference store's
 * fresh-per-test semantics.
 */

runStateStoreConformance("durable-object-sqlite (workerd)", () => {
  const instance = `test-${crypto.randomUUID()}`;
  return createDurableObjectStore(env.BOT_STATE, { partition: () => instance });
});

// A couple of DO-specific integration checks the pure-engine suite can't cover.
describe("Durable Object integration", () => {
  it("isolates state across partitioned instances", async () => {
    const a = createDurableObjectStore(env.BOT_STATE, { partition: () => "inst-a" });
    const b = createDurableObjectStore(env.BOT_STATE, { partition: () => "inst-b" });
    await a.kv.set("shared", { who: "a" });
    await b.kv.set("shared", { who: "b" });
    expect(await a.kv.get("shared")).toEqual({ who: "a" });
    expect(await b.kv.get("shared")).toEqual({ who: "b" });
  });

  it("persists across separate stub resolutions (same instance)", async () => {
    const name = `persist-${crypto.randomUUID()}`;
    const first = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    await first.kv.set("k", { n: 42 }, 60_000);
    // A fresh store/stub to the same instance must observe the committed write.
    const second = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    expect(await second.kv.get("k")).toEqual({ n: 42 });
  });
});
