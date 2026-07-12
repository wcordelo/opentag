import { describe, expect, it } from "vitest";
import { classify } from "../index";

describe("wasm-dispatch classify (TS fallback)", () => {
  it("detects research intent", () => {
    const r = classify("research: Durable Objects naming");
    expect(r.intent).toBe("research");
    expect(r.confidence).toBe(1);
    expect(r.extractedObjective).toBe("Durable Objects naming");
  });

  it("detects triage intent", () => {
    expect(classify("/triage inbox").intent).toBe("triage");
  });

  it("detects questions", () => {
    const r = classify("is this ready?");
    expect(r.intent).toBe("question");
    expect(r.confidence).toBe(0.8);
  });

  it("falls back to unknown", () => {
    expect(classify("hello").intent).toBe("unknown");
  });
});
