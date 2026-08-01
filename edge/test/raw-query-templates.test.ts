import { describe, expect, it } from "vitest";
import {
  parseRawKnowledgeQuery,
  RAW_QUERY_TEMPLATES,
} from "../src/memory/raw-query-templates.js";

describe("bounded raw knowledge query templates", () => {
  it("exposes only named templates with typed parameters", () => {
    expect(RAW_QUERY_TEMPLATES).toEqual([
      "recent_channel_memory",
      "memory_record",
      "source_state",
    ]);
    expect(parseRawKnowledgeQuery({
      template: "recent_channel_memory",
      teamId: "T1",
      channelId: "C1",
      limit: 10,
    })).toMatchObject({ template: "recent_channel_memory", teamId: "T1", limit: 10 });
  });

  it("rejects arbitrary SQL-shaped fields and unbounded limits", () => {
    expect(() => parseRawKnowledgeQuery({
      template: "source_state",
      teamId: "T1",
      sourceKey: "slack:T1:C1:123",
      sql: "SELECT * FROM secrets",
    })).toThrow("raw_query_field_forbidden:sql");
    expect(() => parseRawKnowledgeQuery({
      template: "recent_channel_memory",
      teamId: "T1",
      channelId: "C1",
      limit: 11,
    })).toThrow("raw_query_limit_invalid");
  });
});
