// Frozen optional messaging-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read the Slack connection of an agent on the host, reconnect, pause, resume or remove
// it, list the Slack conversations the agent answers, and read one of them. A member cannot use any
// route; `requireAdmin` on the host is the only gate.
//
// No route carries a token. The credential state is `missing`, `saved` or `unreadable`. A thread
// message longer than 20000 characters is cut by the host before it is sent. The overview also lists
// the Slack workspaces the host connected, by id and name only. Creating an agent's Slack app needs
// the host's own desktop, because Slack returns to that computer's browser, so no route does it.
// Widening any of it needs a second capability string.
import {
  adminRoute,
  boolean,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const MESSAGING_CAPABILITY = "messaging-v1";

export const MESSAGING_ROUTES = {
  overview: "/v1/admin/messaging/overview",
  reconnect: "/v1/admin/messaging/reconnect",
  setEnabled: "/v1/admin/messaging/set-enabled",
  disconnect: "/v1/admin/messaging/disconnect",
  thread: "/v1/admin/messaging/thread",
} as const;

const byAgent = fields({ agentId: identifier });
const name = string(256);
const time = string(64);
const connection = fields({
  agentId: identifier,
  platform: oneOf("slack"),
  enabled: boolean,
  state: oneOf(
    "connecting",
    "connected",
    "reconnecting",
    "paused",
    "invalid_token",
    "missing_scope",
    "rate_limited",
    "secret_storage_unavailable",
    "error",
    "awaiting_install",
    "relay_unavailable",
  ),
  workspaceName: nullable(name),
  botUserId: nullable(name),
  missingScopes: list(string(64), 32),
  retryAt: nullable(time),
  credentials: oneOf("missing", "saved", "unreadable"),
});
const overview = fields({
  connection: nullable(connection),
  threads: list(fields({ linkId: identifier, title: name, isDirect: boolean, updatedAt: time }), 200),
  slackWorkspaces: list(fields({ workspaceId: identifier, name }), 50),
});
const thread = fields({
  linkId: identifier,
  title: name,
  messages: list(
    fields({
      id: identifier,
      role: oneOf("external", "agent"),
      authorName: nullable(name),
      text: string(20_000),
      createdAt: time,
    }),
    200,
  ),
});

export const MESSAGING_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [MESSAGING_ROUTES.overview, adminRoute(byAgent, overview)],
  [MESSAGING_ROUTES.reconnect, adminRoute(byAgent, overview)],
  [MESSAGING_ROUTES.setEnabled, adminRoute(fields({ agentId: identifier, enabled: boolean }), overview)],
  [MESSAGING_ROUTES.disconnect, adminRoute(byAgent, overview)],
  [MESSAGING_ROUTES.thread, adminRoute(fields({ agentId: identifier, linkId: identifier }), thread)],
]);
