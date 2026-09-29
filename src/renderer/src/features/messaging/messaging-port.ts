// The bridge calls of the Slack settings. The desktop asks main, which answers for this computer or
// forwards to a joined host; the web client asks its connected host over the Team API.

import type { MessagingDesktopApi } from "@openbot/contracts/ipc";
import { writeClipboardText } from "../../clipboard";

export interface MessagingPort {
  api: MessagingDesktopApi;
  serverId: string;
  openUrl: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
}

export function desktopMessagingPort(serverId: string): MessagingPort {
  return {
    api: window.openbot.messaging,
    serverId,
    openUrl: (url) => window.openbot.openUrl(url),
    copyText: writeClipboardText,
  };
}
