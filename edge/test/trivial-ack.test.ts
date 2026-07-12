import { describe, it, expect } from "vitest";
import { trivialAck, trivialAckReply } from "../src/trivial-ack.js";

describe("trivialAck", () => {
  it("reacts to thanks", () => {
    expect(trivialAck("ok great thank you")).toEqual({
      mode: "react",
      emoji: "heart",
    });
    expect(trivialAck("thanks!")).toEqual({ mode: "react", emoji: "heart" });
  });

  it("reacts to short oks", () => {
    expect(trivialAck("got it")).toEqual({ mode: "react", emoji: "thumbsup" });
  });

  it("does not swallow real questions", () => {
    expect(trivialAck("what games are tomorrow?")).toBeNull();
  });

  it("legacy string helper still works", () => {
    expect(trivialAckReply("thanks")).toBe("You're welcome.");
  });
});
