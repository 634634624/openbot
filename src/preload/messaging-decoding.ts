// What main answers for the Slack connection of an agent. These guard the renderer; the host replies
// that main receives have their own decoders.

import {
  isMessagingOverview,
  isMessagingThread,
  isSlackSetup,
  type MessagingOverview,
  type MessagingThread,
  type SlackSetup,
} from "@openbot/contracts/ipc";

export function decodeMessagingOverviewReply(value: unknown): MessagingOverview {
  if (!isMessagingOverview(value)) throw new Error("Invalid messaging overview response.");
  return value;
}

export function decodeSlackSetupReply(value: unknown): SlackSetup {
  if (!isSlackSetup(value)) throw new Error("Invalid Slack setup response.");
  return value;
}

export function decodeMessagingThreadReply(value: unknown): MessagingThread {
  if (!isMessagingThread(value)) throw new Error("Invalid messaging thread response.");
  return value;
}
