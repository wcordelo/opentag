import { describe, expect, it } from "vitest";
import { DEFAULT_BUNDLE } from "../src/config/access-bundle.js";
import {
  IssueCard,
  IssueList,
  PageList,
  StatusCard,
} from "../src/components/cards.js";

/** Keep in sync with ALL_EDGE_TOOL_NAMES in src/tools/index.ts */
const EXPECTED_EDGE_TOOLS = [
  "lookup_slack_user",
  "read_thread",
  "confirm_write",
  "issue_card",
  "issue_list",
  "page_list",
  "show_status",
  "show_links",
  "show_incident",
  "research_progress",
  "memory_search",
  "memory_write",
  "start_task",
] as const;

describe("edge triage tools", () => {
  it("DEFAULT_BUNDLE includes all Workers-safe client tools", () => {
    for (const name of EXPECTED_EDGE_TOOLS) {
      expect(DEFAULT_BUNDLE.tools).toContain(name);
    }
    expect(DEFAULT_BUNDLE.tools).not.toContain("render_chart");
    expect(DEFAULT_BUNDLE.tools).not.toContain("render_diagram");
  });

  it("IssueCard / IssueList / PageList / StatusCard return Message trees", () => {
    const card = IssueCard({ identifier: "CPK-1", title: "t" });
    expect(card).toBeTruthy();
    expect((card.props as { accent?: string }).accent).toBeTruthy();
    expect(IssueList({ issues: [{ identifier: "CPK-1", title: "t" }] })).toBeTruthy();
    expect(PageList({ pages: [{ title: "Doc" }] })).toBeTruthy();
    expect(
      StatusCard({ heading: "H", fields: [{ label: "a", value: "1" }] }),
    ).toBeTruthy();
  });
});
