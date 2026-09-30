// What main answers for the Slack connection of an agent. These guard the renderer; the host replies
// that main receives have their own decoders.

import {
  isMessagingOverview,
  isMessagingThread,
  type MessagingOverview,
  type MessagingThread,
} from "@openbot/contracts/ipc";

export function decodeMessagingOverviewReply(value: unknown): MessagingOverview {
  if (!isMessagingOverview(value)) throw new Error("Invalid messaging overview response.");
  return value;
}

export function decodeMessagingThreadReply(value: unknown): MessagingThread {
  if (!isMessagingThread(value)) throw new Error("Invalid messaging thread response.");
  return value;
}
