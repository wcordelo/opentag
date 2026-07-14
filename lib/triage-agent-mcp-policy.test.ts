import { describe, expect, it } from "vitest";
import {
  filterReadOnlyMcpTools,
} from "./triage-agent.js";

describe("production MCP tool policy", () => {
  it("allows explicit reads and denies every mutating or ambiguous tool", () => {
    const exposed = filterReadOnlyMcpTools("Linear", [
      { name: "linear_list_issues" },
      { name: "notion-search" },
      { name: "retrieve_page" },
      { name: "get_and_delete_issue" },
      { name: "get_and_set_issue" },
      { name: "resolve_issue" },
      { name: "save_issue" },
      { name: "create_page" },
      { name: "update_issue" },
      { name: "mystery_operation" },
      { name: "post_comment" },
      { name: "list_drop_database" },
      { name: "get_destroy_workspace" },
      { name: "query_purge_all" },
      { name: "read_insert_record" },
    ], new Set([
      "linear/linear_list_issues",
      "linear/notion-search",
      "linear/retrieve_page",
    ]));
    expect(exposed.map((tool) => tool.name)).toEqual([
      "linear_list_issues",
      "notion-search",
      "retrieve_page",
    ]);
    expect(filterReadOnlyMcpTools("Notion", [
      { name: "linear_list_issues" },
    ], new Set(["linear/linear_list_issues"]))).toEqual([]);
    expect(filterReadOnlyMcpTools("bundle-mcp-0", [
      { name: "list_drop_database" },
    ], new Set())).toEqual([]);
  });
});
