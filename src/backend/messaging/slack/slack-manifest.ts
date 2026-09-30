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
/** Events about the app itself. The connection stops when either arrives. */
const APP_EVENTS = ["app_uninstalled", "tokens_revoked"] as const;

/** Slack limits: 35 characters for an app name, 80 for a bot display name, 139 for a short description. */
const APP_NAME_LIMIT = 35;
const DESCRIPTION_LIMIT = 139;

/** Where an agent's Slack app sends its events, and where its install returns. */
export interface ManagedSlackEndpoints {
  requestUrl: string;
  redirectUrl: string;
}

/**
 * The manifest of one agent's Slack app, which OpenBot creates. Slack posts its events and button
 * presses to the Signal request URL, and it also reports when the app is uninstalled or its token is
 * revoked. Token rotation stays off, because a rotating token would need a refresh on a schedule that
 * a sleeping host cannot keep.
 */
export function slackManifest(agent: { name: string; description: string }, endpoints: ManagedSlackEndpoints) {
  const name = agent.name.trim().slice(0, APP_NAME_LIMIT) || "OpenBot agent";
  return {
    display_information: {
      name,
      description: (agent.description.trim() || `${name}, an OpenBot agent`).slice(0, DESCRIPTION_LIMIT),
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      redirect_urls: [endpoints.redirectUrl],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { request_url: endpoints.requestUrl, bot_events: [...BOT_EVENTS, ...APP_EVENTS] },
      interactivity: { is_enabled: true, request_url: endpoints.requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
