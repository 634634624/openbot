// The Slack route token: the ES256 JWT in a managed Slack app's request URL,
// `https://signal.openbot.run/v1/slack/events/<token>`.
//
// `apps/auth-api` mints it for a host that proves its machine token, and the Signal service
// (`remote/api/src/tokens.ts`) verifies it to find the host that owns a Slack request. It is signed
// with its own key, not the ticket key, so the ticket key can rotate without breaking the request
// URL of every Slack app. It has no expiry, because Slack keeps the URL until the app changes.
//
// The token only routes. It grants nothing: the host refuses any request that Slack did not sign
// with the app's signing secret, which never leaves the host.

export const SLACK_ROUTE_AUDIENCE = "openbot-slack-route";

export const SLACK_ROUTE_PATH_PREFIX = "/v1/slack/events/";

export interface SlackRouteClaims {
  aud: typeof SLACK_ROUTE_AUDIENCE;
  // The remote host that receives the requests.
  hid: string;
  // The host's messaging connection, which names the agent's Slack app on that host.
  cid: string;
  iat: number;
}
