/**
 * Linear / Notion / status cards — Workers-safe Block Kit via channels-ui.
 * Built with jsx/jsxs (no TSX) to match confirm_write.
 */
import { z } from "zod";
import { jsx, jsxs } from "@copilotkit/channels-ui/jsx-runtime";
import type { BotNode } from "@copilotkit/channels-ui";
import {
  Message,
  Header,
  Section,
  Context,
  Fields,
  Field,
  Divider,
  Actions,
  Button,
} from "@copilotkit/channels-ui";
import {
  accentForIssue,
  accentForIssues,
  priorityGlyph,
  stateGlyph,
  ACCENT,
} from "./_status.js";
import { quickActionHandle, type QuickRef } from "../slack/quick-card.js";

export const issueCardSchema = z.object({
  identifier: z.string().describe("Issue identifier, e.g. 'BER-1234'."),
  title: z.string().describe("Issue title."),
  url: z.string().optional().describe("Link to the issue in Linear."),
  state: z.string().optional().describe("Workflow state name."),
  assignee: z.string().optional().describe("Assignee display name."),
  priority: z.string().optional().describe("Priority label."),
  team: z.string().optional().describe("Team key/name, e.g. 'Berendo'."),
  cycle: z.string().optional().describe("Cycle name/number."),
  updated: z.string().optional().describe("Human-readable last-updated."),
  description: z
    .string()
    .optional()
    .describe("Issue description (markdown). Kept short; long text is trimmed."),
  labels: z.array(z.string()).optional().describe("Label names."),
  justCreated: z
    .boolean()
    .optional()
    .describe("Set true right after creating the issue to show a 'Filed' banner."),
});

export type IssueCardProps = z.infer<typeof issueCardSchema>;

export function IssueCard(issue: IssueCardProps): BotNode {
  const titleText = issue.url
    ? `[**${issue.title}**](${issue.url})`
    : `**${issue.title}**`;
  const prio = priorityGlyph(issue.priority);
  const description = issue.description
    ? issue.description.length > 600
      ? `${issue.description.slice(0, 600)}…`
      : issue.description
    : undefined;

  const fieldKids: BotNode[] = [
    jsx(Field, {
      children: `**Status**\n${stateGlyph(issue.state)} ${issue.state ?? "—"}`,
    }),
    jsx(Field, {
      children: `**Assignee**\n${issue.assignee ?? "_unassigned_"}`,
    }),
  ];
  if (issue.priority) {
    fieldKids.push(
      jsx(Field, {
        children: `**Priority**\n${prio ? `${prio} ` : ""}${issue.priority}`,
      }),
    );
  }
  if (issue.team) {
    fieldKids.push(jsx(Field, { children: `**Team**\n${issue.team}` }));
  }
  if (issue.cycle) {
    fieldKids.push(jsx(Field, { children: `**Cycle**\n${issue.cycle}` }));
  }
  if (issue.updated) {
    fieldKids.push(jsx(Field, { children: `**Updated**\n${issue.updated}` }));
  }

  const kids: BotNode[] = [
    jsx(Header, {
      children: `${issue.justCreated ? "✅ " : `${stateGlyph(issue.state)} `}${issue.identifier}`,
    }),
    jsx(Section, { children: titleText }),
  ];
  if (issue.justCreated) {
    kids.push(jsx(Context, { children: "✨ Filed in Linear" }));
  }
  kids.push(jsxs(Fields, { children: fieldKids }));
  if (description) {
    kids.push(jsx(Divider, {}));
    kids.push(jsx(Section, { children: description }));
  }
  const footer: string[] = [];
  if (issue.labels?.length) footer.push(`🏷️ ${issue.labels.join("  ")}`);
  if (issue.url) footer.push(`[Open in Linear →](${issue.url})`);
  if (footer.length) {
    kids.push(jsx(Context, { children: footer.join("   ·   ") }));
  }

  return jsxs(Message, { accent: accentForIssue(issue), children: kids });
}

const issueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string().optional(),
  state: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  updated: z.string().optional(),
});

export const issueListSchema = z.object({
  heading: z.string().optional(),
  issues: z.array(issueSchema).min(1),
});

export type IssueListProps = z.infer<typeof issueListSchema>;

const MAX = 15;
const TITLE_MAX = 70;

export function IssueList({ heading, issues }: IssueListProps): BotNode {
  const lines = issues.slice(0, MAX).map((issue) => {
    const idLink = issue.url
      ? `[**${issue.identifier}**](${issue.url})`
      : `**${issue.identifier}**`;
    const title =
      issue.title.length > TITLE_MAX
        ? `${issue.title.slice(0, TITLE_MAX)}…`
        : issue.title;
    const meta = `${issue.assignee ?? "unassigned"}${issue.updated ? ` · ${issue.updated}` : ""}`;
    return `${stateGlyph(issue.state)} ${idLink} ${title} — ${meta}`;
  });
  const footer =
    issues.length > MAX
      ? `Showing ${MAX} of ${issues.length} issues`
      : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  // Quick action (SPEC §3.4): clicking re-runs the search as a synthetic turn
  // authored by the clicking user (see slack/quick-actions.ts).
  const retryRef: QuickRef = {
    type: "issue_list",
    ...(heading ? { heading: heading.slice(0, 150) } : {}),
  };

  return jsxs(Message, {
    accent: accentForIssues(issues),
    children: [
      jsx(Header, { children: `📋  ${heading ?? "Linear issues"}` }),
      jsx(Section, { children: lines.join("\n") }),
      jsx(Context, { children: footer }),
      jsx(Actions, {
        children: jsx(Button, {
          onClick: quickActionHandle("retry"),
          value: retryRef,
          children: "🔁 Retry search",
        }),
      }),
    ],
  });
}

const pageSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  editedBy: z.string().optional(),
  edited: z.string().optional(),
});

export const pageListSchema = z.object({
  heading: z.string().optional(),
  pages: z.array(pageSchema).min(1),
});

export type PageListProps = z.infer<typeof pageListSchema>;

export function PageList({ heading, pages }: PageListProps): BotNode {
  const rows: BotNode[] = [];
  pages.forEach((page, i) => {
    const titleLink = page.url
      ? `[**${page.title}**](${page.url})`
      : `**${page.title}**`;
    const meta = [
      page.snippet,
      page.edited
        ? `🕒 edited ${page.edited}${page.editedBy ? ` by ${page.editedBy}` : ""}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    rows.push(jsx(Section, { children: `📄  ${titleLink}` }));
    if (meta) rows.push(jsx(Context, { children: meta }));
    if (i < pages.length - 1) rows.push(jsx(Divider, {}));
  });

  return jsxs(Message, {
    accent: ACCENT.notion,
    children: [
      jsx(Header, { children: `📚  ${heading ?? "Notion pages"}` }),
      ...rows,
      jsx(Context, {
        children: `${pages.length} page${pages.length === 1 ? "" : "s"}`,
      }),
    ],
  });
}

export const statusSchema = z.object({
  heading: z.string(),
  fields: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .min(1),
});

export function StatusCard({
  heading,
  fields,
}: z.infer<typeof statusSchema>): BotNode {
  return jsxs(Message, {
    accent: "#5E6AD2",
    children: [
      jsx(Header, { children: `📊 ${heading}` }),
      jsxs(Fields, {
        children: fields.map((f) =>
          jsx(Field, { children: `**${f.label}**\n${f.value}` }),
        ),
      }),
    ],
  });
}

export const linksSchema = z.object({
  heading: z.string(),
  links: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .min(1),
});

export function LinksCard({
  heading,
  links,
}: z.infer<typeof linksSchema>): BotNode {
  return jsxs(Message, {
    children: [
      jsx(Header, { children: `🔗 ${heading}` }),
      jsx(Section, {
        children: links.map((l) => `[${l.label}](${l.url})`).join("  ·  "),
      }),
    ],
  });
}

export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["SEV1", "SEV2", "SEV3"]),
  summary: z.string(),
});

export function IncidentCard({
  id,
  title,
  severity,
  summary,
  choiceId,
}: z.infer<typeof incidentSchema> & { choiceId: string }): BotNode {
  const accent =
    severity === "SEV1"
      ? "#EB5757"
      : severity === "SEV2"
        ? "#F2994A"
        : "#5E6AD2";
  return jsxs(Message, {
    accent,
    children: [
      jsx(Header, { children: `🚨 ${severity} · ${title}` }),
      jsx(Section, { children: summary }),
      jsx(Context, { children: `Incident ${id}` }),
      jsxs(Actions, {
        children: [
          jsx(Button, {
            value: { action: "ack", id, choiceId },
            style: "primary",
            children: "Acknowledge",
          }),
          jsx(Button, {
            value: { action: "escalate", id, choiceId },
            style: "danger",
            children: "Escalate",
          }),
        ],
      }),
    ],
  });
}

export function RemoteGitApprovalCard({
  repository,
  requester,
  choiceId,
}: {
  repository: string;
  requester: string;
  choiceId: string;
}): BotNode {
  return jsxs(Message, {
    accent: "#F2994A",
    children: [
      jsx(Header, { children: "GitHub push + pull request approval" }),
      jsx(Section, {
        children:
          `This coding task may push its dedicated temporary branch to **${repository}** ` +
          `and open a GitHub pull request for that repository, attributed to **${requester}**.`,
      }),
      jsx(Context, {
        children:
          "This turn pauses here until you choose Approve or Cancel. " +
          "Follow-up messages in this thread are rejected while it waits. " +
          "Cancel keeps remote Git writes disabled and continues the coding turn locally.",
      }),
      jsxs(Actions, {
        children: [
          jsx(Button, {
            value: { confirmed: true, choiceId },
            style: "primary",
            children: "Approve push + PR",
          }),
          jsx(Button, {
            value: { confirmed: false, choiceId },
            children: "Cancel",
          }),
        ],
      }),
    ],
  });
}
