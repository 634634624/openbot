// The bridge calls of the Slack settings. The desktop asks main, which answers for this computer or
// forwards to a joined host; the web client asks its connected host over the Team API.

import type { MessagingDesktopApi } from "@openbot/contracts/ipc";
import { writeClipboardText } from "../../clipboard";

export interface MessagingPort {
  api: MessagingDesktopApi;
  serverId: string;
  /**
   * True when this screen runs on the computer that runs the agent. Only then can it create a
   * managed Slack app, because Slack returns to this computer's browser.
   */
  managedApps: boolean;
  openUrl: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
}

export function desktopMessagingPort(serverId: string, managedApps: boolean): MessagingPort {
  return {
    api: window.openbot.messaging,
    serverId,
    managedApps,
    openUrl: (url) => window.openbot.openUrl(url),
    copyText: writeClipboardText,
  };
}
