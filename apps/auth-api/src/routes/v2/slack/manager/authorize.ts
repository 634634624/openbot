import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  json,
  requestSlackManager,
  requestUser,
  slackManagerErrorResponse,
} from "../../../../server/request-auth";

// Starts the Slack manager app's consent for one sign-in of one host. The host sends a one-use
// public key, and the token comes back sealed to it.
export const Route = createFileRoute("/v2/slack/manager/authorize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          if (!isString(body.hostNonce) || !isString(body.hostPublicKey))
            return apiError(400, "invalid_slack_request", "The Slack sign-in request is invalid.");
          const authorizeUrl = await requestSlackManager().authorizeUrl(user, {
            hostNonce: body.hostNonce,
            hostPublicKey: body.hostPublicKey,
            redirectUri: new URL("/v2/slack/manager/callback", request.url).toString(),
          });
          return json({ authorizeUrl });
        } catch (error) {
          return slackManagerErrorResponse(error);
        }
      },
    },
  },
});
