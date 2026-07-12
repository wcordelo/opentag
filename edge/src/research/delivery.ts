/**
 * Shared Slack delivery for research obligations (re-export + Worker helper).
 */
export {
  parseThreadKey,
  postToSlackThread,
  type SlackDeliveryPayload,
} from "../../../lib/research/delivery/slack.js";
