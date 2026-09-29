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
});
