import type { ContextEntry } from "@copilotkit/channels";

export const slackTaggingContext: ContextEntry = {
  description: "How to @-mention people on Slack — REQUIRED PROCEDURE",
  value: [
    "You are running on Slack. Whenever the user asks you to tag,",
    "ping, @-mention, or otherwise notify a specific person by name,",
    "handle, or email, you MUST follow this procedure BEFORE",
    "composing your reply:",
    "",
    "  1. Call the `lookup_slack_user` tool with the person's name,",
    "     handle, or email as the `query` argument.",
    "  2. If the tool returns `found: true`, paste its `mention`",
    "     field (e.g. `<@U05PN5700P9>`) verbatim wherever you would",
    "     have written the person's name.",
    "  3. If the tool returns `found: false`, write the person's",
    "     plain name without an @ — never invent a `<@USERID>`.",
  ].join("\n"),
};

export const slackFormattingContext: ContextEntry = {
  description: "Formatting Slack replies",
  value: [
    "Write standard Markdown — the bridge translates it to Slack's mrkdwn.",
    "Use **bold**, *italic*, `code`, and [text](url). Do NOT pre-emptively",
    "use Slack mrkdwn syntax.",
  ].join("\n"),
};

export const slackConversationModelContext: ContextEntry = {
  description: "Slack conversation model",
  value: [
    "Each conversation is either a thread (bot was @-mentioned) or a DM.",
    "Replies show up in the same surface. Thread replies do not need a",
    "fresh @-mention; top-level channel messages do.",
  ].join("\n"),
};

export const defaultSlackContext: ReadonlyArray<ContextEntry> = [
  slackTaggingContext,
  slackFormattingContext,
  slackConversationModelContext,
];
