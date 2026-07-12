import { describe, it, expect } from "vitest";
import { AsyncMutex } from "../mutex.js";

describe("AsyncMutex", () => {
  it("serializes concurrent calls", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    await Promise.all([
      mutex.serialize(async () => {
        await sleep(20);
        order.push(1);
      }),
      mutex.serialize(async () => {
        order.push(2);
      }),
    ]);

    expect(order).toEqual([1, 2]);
  });
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
