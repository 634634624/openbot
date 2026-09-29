import type { MessagingConnection, MessagingDesktopApi } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentSlackSettings } from "../src/features/messaging/AgentSlackSettings";
import type { MessagingPort } from "../src/features/messaging/messaging-port";
import { createMockMessaging } from "../src/preview/mock-messaging";

const STORY_TOKENS = { agentId: "chief", botToken: "xoxb-preview-token", appToken: "xapp-preview-token" };

/** The preview host, with the connection already made and then changed by `connection`. */
function storyPort(connection?: Partial<MessagingConnection>): MessagingPort {
  const api: MessagingDesktopApi = createMockMessaging((agentId) => (agentId === "chief" ? "Chief" : undefined));
  const ready = connection ? api.connectSlack(STORY_TOKENS, "local") : Promise.resolve();
  return {
    api: {
      ...api,
      getOverview: async (input, serverId) => {
        await ready;
        const overview = await api.getOverview(input, serverId);
        return overview.connection && connection
          ? { ...overview, connection: { ...overview.connection, ...connection } }
          : overview;
      },
    },
    serverId: "local",
    openUrl: async () => undefined,
    copyText: async () => undefined,
  };
}

function SlackStory(props: { connection?: Partial<MessagingConnection> }) {
  return (
    <main
      style={{
        position: "relative",
        width: "380px",
        height: "760px",
        overflow: "hidden",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <AgentSlackSettings
        port={storyPort(props.connection)}
        agentId="chief"
        agentName="Chief"
        onBack={fn()}
        onClose={fn()}
      />
    </main>
  );
}

const meta = {
  title: "Agents/Agent Slack Settings",
  component: SlackStory,
} satisfies Meta<typeof SlackStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Setup: Story = {};

export const Connected: Story = { args: { connection: {} } };

export const TokenNotAccepted: Story = { args: { connection: { state: "invalid_token" } } };

export const MissingPermissions: Story = {
  args: { connection: { state: "missing_scope", missingScopes: ["files:write", "reactions:write"] } },
};
