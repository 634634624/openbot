import { defineMessages } from "../../message";

export const messages = defineMessages("messaging", {
  // Agent settings > Slack: connect an agent to a Slack app, and the conversations it answers there.
  "messaging.slack.title": "Slack",
  "messaging.slack.back": "Back to agent settings",
  "messaging.slack.close": "Close agent settings",
  "messaging.slack.intro":
    "People in Slack can mention {name} in a channel or send it a direct message. {name} answers in that thread.",
  "messaging.slack.loadFailed": "Could not load the Slack connection.",

  "messaging.slack.managed.title": "Add {name} to Slack",
  "messaging.slack.managed.intro":
    "OpenBot creates a Slack app for {name}, with its own name. People can mention it in channels and send it direct messages.",
  "messaging.slack.managed.connectStep":
    "Connect your Slack workspace. Slack opens in your browser, and you select the workspace there.",
  "messaging.slack.managed.connect": "Connect Slack",
  "messaging.slack.managed.connected": "Connected to {workspace}.",
  "messaging.slack.managed.disconnectWorkspace": "Disconnect workspace",
  "messaging.slack.managed.addStep": "Add {name} to the workspace. Slack asks you to allow the app.",
  "messaging.slack.managed.add": "Add to Slack",
  "messaging.slack.managed.limit": "A free Slack workspace allows up to 10 apps, and each agent uses one.",
  "messaging.slack.managed.hostOnly": "Add {name} to Slack in OpenBot on the computer that runs it.",

  "messaging.slack.status.title": "Connection",
  "messaging.slack.status.workspace": "Workspace",
  "messaging.slack.status.reconnect": "Reconnect",
  "messaging.slack.status.pause": "Pause",
  "messaging.slack.status.resume": "Resume",
  "messaging.slack.status.disconnect": "Disconnect",
  "messaging.slack.status.disconnectTitle": "Disconnect Slack?",
  "messaging.slack.status.disconnectDescription":
    "OpenBot deletes the Slack app of this agent and removes its tokens from the host. The conversations stay.",
  "messaging.slack.status.install": "Install in Slack",
  "messaging.slack.status.missingScopes":
    "The Slack app does not have these permissions: {scopes}. Add them in OAuth & Permissions, reinstall the app, then reconnect.",
  "messaging.slack.status.retryAt": "Slack asked OpenBot to wait. It tries again at {time}.",

  "messaging.state.connecting": "Connecting",
  "messaging.state.connected": "Connected",
  "messaging.state.reconnecting": "Reconnecting",
  "messaging.state.paused": "Paused",
  "messaging.state.invalid_token": "Token not accepted",
  "messaging.state.missing_scope": "Missing permissions",
  "messaging.state.rate_limited": "Waiting for Slack",
  "messaging.state.secret_storage_unavailable": "Tokens unreadable",
  "messaging.state.error": "Error",
  "messaging.state.awaiting_install": "Waiting for install",
  "messaging.state.relay_unavailable": "Cannot receive events",
  "messaging.help.invalid_token":
    "Slack no longer accepts the app of this agent. It may have been uninstalled. Disconnect, then add the agent to Slack again.",
  "messaging.help.secret_storage_unavailable":
    "OpenBot cannot read the saved tokens on the host. Disconnect, then connect again.",
  "messaging.help.relay_unavailable":
    "OpenBot cannot receive Slack events on this computer. Sign in, give this computer a name in Server settings, and keep OpenBot open.",
  "messaging.help.awaiting_install":
    "Install the app in Slack to finish. If a workspace admin must approve new apps, the install waits for them.",

  "messaging.slack.warning":
    "Anyone who can post in the Slack workspace can give {name} work. {name} runs on the host with the access you gave it, and a hosted server stays awake while Slack is connected.",

  "messaging.slack.threads.title": "Conversations",
  "messaging.slack.threads.empty": "No conversations yet. Mention {name} in Slack to start one.",
  "messaging.slack.threads.direct": "Direct message from {name}",
  "messaging.slack.thread.back": "Back to Slack",
  "messaging.slack.thread.loadFailed": "Could not load this conversation.",
});
