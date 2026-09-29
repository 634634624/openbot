import type { SlackSetup } from "@openbot/contracts/ipc";

/** What the agent needs from Slack. `auth.test` reports the granted scopes, and a missing one shows in the UI. */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "reactions:write",
  "users:read",
] as const;

const BOT_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"] as const;

/** Slack limits: 35 characters for an app name, 80 for a bot display name, 139 for a short description. */
const APP_NAME_LIMIT = 35;
const DESCRIPTION_LIMIT = 139;

/**
 * The manifest of the Slack app for one agent. Socket Mode is on, so Slack needs no request URL:
 * the host opens the connection. Token rotation stays off, because a rotating token would need a
 * refresh token and a client secret that the host does not keep.
 */
export function slackSetup(agent: { name: string; description: string }): SlackSetup {
  const name = agent.name.trim().slice(0, APP_NAME_LIMIT) || "OpenBot agent";
  const manifest = {
    display_information: {
      name,
      description: (agent.description.trim() || `${name}, an OpenBot agent`).slice(0, DESCRIPTION_LIMIT),
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  return {
    manifestJson,
    createAppUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
  };
}
