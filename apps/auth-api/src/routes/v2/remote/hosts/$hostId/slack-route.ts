import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../server/json-body";
import { slackRequestUrl } from "../../../../../server/remote-control-plane";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestRemoteSignalUrl,
} from "../../../../../server/request-auth";

// The request URL of one agent's managed Slack app. The host proves its machine token, as it does
// for a Signal ticket, and puts the URL in the app's manifest.
export const Route = createFileRoute("/v2/remote/hosts/$hostId/slack-route")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const body = await readJsonObject(request);
          if (!isString(body.machineToken) || !isString(body.connectionId))
            return apiError(400, "invalid_remote_request", "The host credential is invalid.");
          const routeToken = await requestRemoteControlPlane().issueSlackRoute(
            params.hostId,
            body.machineToken,
            body.connectionId,
          );
          return json({ requestUrl: slackRequestUrl(requestRemoteSignalUrl(), routeToken) });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
