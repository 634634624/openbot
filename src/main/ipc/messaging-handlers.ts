// The Slack connection of one agent. On a joined server the agent runs on the host, so the request
// goes there, and the host answers only an owner or admin. Tokens only travel towards the host; no
// result carries one.

import { decodeMessagingOverview, decodeMessagingThread, decodeSlackSetup } from "@openbot/contracts/ipc";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { MESSAGING_CAPABILITY, MESSAGING_ROUTES } from "@openbot/contracts/team-protocol/messaging-v1";
import { sourceText } from "@openbot/i18n/source";
import type { MessagingService } from "../../backend/messaging/messaging-service";
import type { ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import type { IpcGroupHandlers } from "./define-ipc-group";
import {
  parseConnectSlackInput,
  parseMessagingAgentInput,
  parseReadMessagingThreadInput,
  parseSetMessagingEnabledInput,
} from "./messaging-inputs";
import { scopedHandler } from "./scoped-handler";

interface MessagingRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(serverId: string, path: string, decoder: ResponseDecoder<T>, init?: RemoteRequestInit): Promise<T>;
}

interface MessagingIpcDependencies {
  messaging: Pick<
    MessagingService,
    "overview" | "slackSetup" | "connectSlack" | "reconnect" | "setEnabled" | "disconnect" | "readThread"
  >;
  remoteServers: MessagingRemoteServers;
}

export function messagingIpcHandlers({
  messaging,
  remoteServers,
}: MessagingIpcDependencies): Pick<IpcGroupHandlers, "messaging"> {
  function remote<T>(serverId: string, path: string, body: unknown, decoder: ResponseDecoder<T>): Promise<T> {
    if (!remoteServers.supportsCapability(serverId, MESSAGING_CAPABILITY))
      throw new Error(sourceText("error.messaging.unsupported"));
    return remoteServers.request(serverId, path, decoder, { method: "POST", body });
  }

  return {
    messaging: {
      getOverview: scopedHandler(parseMessagingAgentInput, {
        local: ({ agentId }) => messaging.overview(agentId),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.overview, input, decodeMessagingOverview),
      }),
      getSlackSetup: scopedHandler(parseMessagingAgentInput, {
        local: ({ agentId }) => messaging.slackSetup(agentId),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.slackSetup, input, decodeSlackSetup),
      }),
      connectSlack: scopedHandler(parseConnectSlackInput, {
        local: (input) => messaging.connectSlack(input),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.slackConnect, input, decodeMessagingOverview),
      }),
      reconnect: scopedHandler(parseMessagingAgentInput, {
        local: ({ agentId }) => messaging.reconnect(agentId),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.reconnect, input, decodeMessagingOverview),
      }),
      setEnabled: scopedHandler(parseSetMessagingEnabledInput, {
        local: ({ agentId, enabled }) => messaging.setEnabled(agentId, enabled),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.setEnabled, input, decodeMessagingOverview),
      }),
      disconnect: scopedHandler(parseMessagingAgentInput, {
        local: ({ agentId }) => messaging.disconnect(agentId),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.disconnect, input, decodeMessagingOverview),
      }),
      readThread: scopedHandler(parseReadMessagingThreadInput, {
        local: ({ agentId, linkId }) => messaging.readThread(agentId, linkId),
        remote: (input, serverId) => remote(serverId, MESSAGING_ROUTES.thread, input, decodeMessagingThread),
      }),
    },
  };
}
