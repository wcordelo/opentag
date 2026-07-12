import { describe, it, expect } from "vitest";
import { isUrlAllowed } from "../tools/scrape.js";

describe("SSRF URL policy", () => {
  it("allows public https URLs", () => {
    expect(isUrlAllowed("https://example.com/page")).toBe(true);
  });

  it("blocks localhost", () => {
    expect(isUrlAllowed("http://localhost/admin")).toBe(false);
    expect(isUrlAllowed("http://127.0.0.1/")).toBe(false);
  });

  it("blocks metadata endpoints", () => {
    expect(isUrlAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("blocks private IP ranges", () => {
    expect(isUrlAllowed("http://10.0.0.1/internal")).toBe(false);
    expect(isUrlAllowed("http://192.168.1.1/")).toBe(false);
  });

  it("blocks non-http schemes", () => {
    expect(isUrlAllowed("file:///etc/passwd")).toBe(false);
  });
});
