/** Slack conversation scope constants (Bolt-free). */
export const DM_SCOPE = "dm";

export type ConversationKey = {
  channelId: string;
  scope: string;
};
