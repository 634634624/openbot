// The bridge calls of the Slack settings. The desktop asks main, which answers for this computer or
// forwards to a joined host; the web client asks its connected host over the Team API.

import type { MessagingDesktopApi } from "@openbot/contracts/ipc";

export interface MessagingPort {
  api: MessagingDesktopApi;
  serverId: string;
  /**
   * True when this screen runs on the computer that runs the agent. Only then can it add the agent
   * to Slack, because Slack returns to this computer's browser.
   */
  managedApps: boolean;
}

export function desktopMessagingPort(serverId: string, managedApps: boolean): MessagingPort {
  return { api: window.openbot.messaging, serverId, managedApps };
}
