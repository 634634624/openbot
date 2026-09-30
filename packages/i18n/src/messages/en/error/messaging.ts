import { defineMessages } from "../../../message";

export const messages = defineMessages("error.messaging", {
  // Errors of the Slack connection of an agent, which the host sends.
  "error.messaging.threadNotFound": "The Slack conversation was not found.",
  "error.messaging.notConnected": "This agent is not connected to Slack.",
  "error.messaging.unsupported": "This server cannot connect agents to Slack.",
  "error.messaging.relayUnavailable":
    "OpenBot cannot receive Slack events on this computer. Sign in, give this computer a name, and try again.",
  "error.messaging.workspaceNotConnected": "Connect the Slack workspace first.",
  "error.messaging.slackAppLimit":
    "Slack does not allow more apps in this workspace. Remove an app you do not use, or connect with your own Slack app.",
  "error.messaging.slackAppRefused":
    "Slack did not create the app. A workspace admin may need to allow new apps. Try again, or connect with your own Slack app.",
  "error.messaging.slackInstallFailed": "Slack did not finish the install. Open the install page again.",
  "error.messaging.slackAppNotDeleted":
    "OpenBot disconnected the agent, but Slack did not delete its app. Delete it in the app settings at api.slack.com/apps.",
  "error.messaging.managedOnHost": "Create the Slack app in OpenBot on the computer that runs the agent.",
});
