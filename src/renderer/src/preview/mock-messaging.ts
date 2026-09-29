import type {
  MessagingConnection,
  MessagingDesktopApi,
  MessagingOverview,
  MessagingThread,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { clone } from "./mock-support";

const PREVIEW_THREADS: MessagingThread[] = [
  {
    linkId: "mock-slack-thread-release",
    title: "#launch · Can you check the release notes?",
    messages: [
      {
        id: "mock-slack-message-1",
        role: "external",
        authorName: "Ada",
        text: "Can you check the release notes for typos?",
        createdAt: "2026-09-29T09:00:00.000Z",
      },
      {
        id: "mock-slack-message-2",
        role: "agent",
        authorName: null,
        text: "I found two typos in the Added section and fixed them in the draft.",
        createdAt: "2026-09-29T09:01:30.000Z",
      },
    ],
  },
  {
    linkId: "mock-slack-thread-direct",
    title: "Grace",
    messages: [
      {
        id: "mock-slack-message-3",
        role: "external",
        authorName: "Grace",
        text: "What is on the board for today?",
        createdAt: "2026-09-29T10:15:00.000Z",
      },
    ],
  },
];

/**
 * The Slack connection of each preview agent. A connect with tokens of the right form connects at
 * once to a preview workspace that already has two conversations; anything else fails the way the
 * host does.
 */
export function createMockMessaging(agentName: (agentId: string) => string | undefined): MessagingDesktopApi {
  const connections = new Map<string, MessagingConnection>();
  const requireAgent = (agentId: string) => {
    const name = agentName(agentId);
    if (!name) throw new Error(sourceText("error.team.agentNotFound"));
    return name;
  };
  const overview = (agentId: string): MessagingOverview => {
    requireAgent(agentId);
    const connection = connections.get(agentId) ?? null;
    return clone({
      connection,
      threads:
        connection?.credentials === "saved"
          ? PREVIEW_THREADS.map((thread, index) => ({
              linkId: thread.linkId,
              title: thread.title,
              isDirect: index === 1,
              updatedAt: thread.messages.at(-1)?.createdAt ?? "2026-09-29T09:00:00.000Z",
            }))
          : [],
    });
  };
  const change = (agentId: string, update: Partial<MessagingConnection>): MessagingOverview => {
    const current = connections.get(agentId);
    if (!current) throw new Error(sourceText("error.messaging.notConnected"));
    connections.set(agentId, { ...current, ...update });
    return overview(agentId);
  };
  return {
    getOverview: async ({ agentId }) => overview(agentId),
    getSlackSetup: async ({ agentId }) => {
      const name = requireAgent(agentId);
      const manifest = {
        display_information: { name },
        settings: { socket_mode_enabled: true, interactivity: { is_enabled: true } },
      };
      return {
        manifestJson: JSON.stringify(manifest, null, 2),
        createAppUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
      };
    },
    connectSlack: async ({ agentId, botToken, appToken }) => {
      requireAgent(agentId);
      if (!botToken.startsWith("xoxb-")) throw new Error(sourceText("error.messaging.botTokenInvalid"));
      if (!appToken.startsWith("xapp-")) throw new Error(sourceText("error.messaging.appTokenInvalid"));
      connections.set(agentId, {
        agentId,
        platform: "slack",
        enabled: true,
        state: "connected",
        workspaceName: "Preview workspace",
        botUserId: "U0PREVIEW",
        missingScopes: [],
        retryAt: null,
        credentials: "saved",
      });
      return overview(agentId);
    },
    reconnect: async ({ agentId }) => change(agentId, { enabled: true, state: "connected" }),
    setEnabled: async ({ agentId, enabled }) => change(agentId, { enabled, state: enabled ? "connected" : "paused" }),
    disconnect: async ({ agentId }) =>
      change(agentId, {
        enabled: false,
        state: "paused",
        workspaceName: null,
        botUserId: null,
        credentials: "missing",
      }),
    readThread: async ({ agentId, linkId }) => {
      requireAgent(agentId);
      const thread = PREVIEW_THREADS.find((candidate) => candidate.linkId === linkId);
      if (!thread || connections.get(agentId)?.credentials !== "saved")
        throw new Error(sourceText("error.messaging.threadNotFound"));
      return clone(thread);
    },
  };
}
