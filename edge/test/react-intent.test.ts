import { describe, expect, it } from "vitest";
import { reactIntent } from "../src/react-intent.js";

describe("reactIntent", () => {
  it("detects react-to-message", () => {
    expect(reactIntent("react to my message")).toEqual({
      action: "react",
      emoji: "+1",
    });
    expect(reactIntent("react to this mesage")).toEqual({
      action: "react",
      emoji: "+1",
    });
    expect(reactIntent("<@U123> react to that message please")).toEqual({
      action: "react",
      emoji: "+1",
    });
  });

  it("parses emoji", () => {
    expect(reactIntent("react to my message with heart")).toEqual({
      action: "react",
      emoji: "heart",
    });
    expect(reactIntent("react to this with :fire:")).toEqual({
      action: "react",
      emoji: "fire",
    });
    expect(reactIntent("react with heart")).toEqual({
      action: "react",
      emoji: "heart",
    });
  });

  it("treats 'with no heart' as default emoji, not no_heart", () => {
    expect(reactIntent("react with no heart")).toEqual({
      action: "react",
      emoji: "+1",
    });
    expect(reactIntent("react without heart")).toEqual({
      action: "react",
      emoji: "+1",
    });
  });

  it("detects don't-react", () => {
    expect(reactIntent("dont react to my message")).toEqual({
      action: "skip",
    });
    expect(reactIntent("don't react")).toEqual({ action: "skip" });
    expect(reactIntent("do not react to it")).toEqual({ action: "skip" });
  });

  it("ignores unrelated text", () => {
    expect(reactIntent("what games are on")).toBeNull();
    expect(reactIntent("how do reactions work in slack")).toBeNull();
  });
});
