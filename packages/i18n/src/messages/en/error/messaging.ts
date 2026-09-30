import { defineMessages } from "../../../message";

export const messages = defineMessages("error.messaging", {
  // Errors of the Slack connection of an agent, which the host sends.
  "error.messaging.threadNotFound": "The Slack conversation was not found.",
  "error.messaging.notConnected": "This agent is not connected to Slack.",
  "error.messaging.unsupported": "This server cannot connect agents to Slack.",
  "error.messaging.botTokenInvalid": "Enter a bot token that starts with xoxb-.",
  "error.messaging.appTokenInvalid": "Enter an app-level token that starts with xapp-.",
  "error.messaging.botTokenRejected": "Slack did not accept the bot token.",
  "error.messaging.slackUnavailable": "Slack could not be reached. Try again.",
  "error.messaging.relayUnavailable":
    "OpenBot cannot receive Slack events on this computer. Sign in, give this computer a name, and try again.",
  "error.messaging.workspaceNotConnected": "Connect the Slack workspace first.",
  "error.messaging.slackAppLimit":
    "Slack does not allow more apps in this workspace. Remove an app you do not use, or connect with your own Slack app.",
  "error.messaging.slackAppRefused":
    "Slack did not create the app. A workspace admin may need to allow new apps. Try again, or connect with your own Slack app.",
  "error.messaging.slackInstallFailed": "Slack did not finish the install. Open the install page again.",
  "error.messaging.managedOnHost": "Create the Slack app in OpenBot on the computer that runs the agent.",
});
