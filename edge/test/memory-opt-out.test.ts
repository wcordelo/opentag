import { describe, expect, it } from "vitest";
import { detectMemoryOptOut } from "../src/router/jev-route-questions.js";

describe("detectMemoryOptOut", () => {
  it("matches documented opt-out phrases including apostrophe variants", () => {
    expect(detectMemoryOptOut("answer without using memory")).toBe(true);
    expect(detectMemoryOptOut("explain HTTP status codes, don't look anything up")).toBe(true);
    expect(detectMemoryOptOut("explain HTTP status codes, dont look anything up")).toBe(true);
    expect(detectMemoryOptOut("explain HTTP status codes, don\u2019t look anything up")).toBe(true);
    expect(detectMemoryOptOut("please do not look anything up when answering")).toBe(true);
    expect(detectMemoryOptOut("from general knowledge only: what is RRF?")).toBe(true);
    expect(detectMemoryOptOut("define SSE in one sentence, no memory")).toBe(true);
  });

  it("does not flag ordinary messages that mention lookup or memory in context", () => {
    expect(detectMemoryOptOut("what is the deploy status?")).toBe(false);
    expect(detectMemoryOptOut("please look up the wiki page for auth")).toBe(false);
    expect(detectMemoryOptOut("search code for RouterMeasurementDO usage")).toBe(false);
    expect(detectMemoryOptOut("remind me what William said about shadow-only Jev")).toBe(false);
    expect(detectMemoryOptOut("I don't use spreadsheets for incident tracking")).toBe(false);
  });
});
