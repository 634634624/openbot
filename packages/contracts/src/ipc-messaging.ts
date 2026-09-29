/**
 * Messaging connections: an agent that answers in an external chat platform, such as Slack. The
 * connection belongs to the computer that runs the agent. Tokens travel only towards that host; no
 * result carries one.
 */

import { isBoundedString, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";

export const MESSAGING_PLATFORMS = ["slack"] as const;
export type MessagingPlatform = (typeof MESSAGING_PLATFORMS)[number];

export const MESSAGING_CONNECTION_STATES = [
  "connecting",
  "connected",
  "reconnecting",
  "paused",
  "invalid_token",
  "missing_scope",
  "tokens_mismatch",
  "rate_limited",
  "socket_mode_off",
  "secret_storage_unavailable",
  "error",
] as const;
export type MessagingConnectionState = (typeof MESSAGING_CONNECTION_STATES)[number];

export const MESSAGING_CREDENTIAL_STATES = ["missing", "saved", "unreadable"] as const;
export type MessagingCredentialState = (typeof MESSAGING_CREDENTIAL_STATES)[number];

/** Bounds shared by the IPC guards and the `messaging-v1` wire codec. */
export const MESSAGING_LIMITS = {
  name: 256,
  scope: 64,
  scopes: 32,
  token: 256,
  threads: 200,
  threadMessages: 200,
  messageText: 20_000,
  manifest: 16_000,
  url: 32_000,
} as const;

export interface MessagingConnection {
  agentId: string;
  platform: MessagingPlatform;
  enabled: boolean;
  state: MessagingConnectionState;
  workspaceName: string | null;
  /** The platform user that the agent posts as. */
  botUserId: string | null;
  missingScopes: string[];
  /** When the connection tries again after a rate limit, as an ISO time. */
  retryAt: string | null;
  credentials: MessagingCredentialState;
}

/** One external conversation that the agent answers in its own execution thread. */
export interface MessagingThreadSummary {
  linkId: string;
  title: string;
  isDirect: boolean;
  updatedAt: string;
}

export interface MessagingOverview {
  connection: MessagingConnection | null;
  threads: MessagingThreadSummary[];
}

export interface MessagingThreadMessage {
  id: string;
  role: "external" | "agent";
  /** The external author. Null for the agent. */
  authorName: string | null;
  text: string;
  createdAt: string;
}

export interface MessagingThread {
  linkId: string;
  title: string;
  messages: MessagingThreadMessage[];
}

export interface SlackSetup {
  /** The app manifest, as JSON text that the user can paste into Slack. */
  manifestJson: string;
  /** Opens the Slack "Create app" page with the manifest filled in. */
  createAppUrl: string;
}

export interface MessagingAgentInput {
  agentId: string;
}

export interface ConnectSlackInput {
  agentId: string;
  botToken: string;
  appToken: string;
}

export interface SetMessagingEnabledInput {
  agentId: string;
  enabled: boolean;
}

export interface ReadMessagingThreadInput {
  agentId: string;
  linkId: string;
}

function isScopeList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MESSAGING_LIMITS.scopes &&
    value.every((scope) => isBoundedString(scope, MESSAGING_LIMITS.scope))
  );
}

export function isMessagingConnection(value: unknown): value is MessagingConnection {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    isOneOf(MESSAGING_PLATFORMS, value.platform) &&
    isBoolean(value.enabled) &&
    isOneOf(MESSAGING_CONNECTION_STATES, value.state) &&
    isNullableBoundedString(value.workspaceName, MESSAGING_LIMITS.name) &&
    isNullableBoundedString(value.botUserId, MESSAGING_LIMITS.name) &&
    isScopeList(value.missingScopes) &&
    isNullableBoundedString(value.retryAt, 64) &&
    isOneOf(MESSAGING_CREDENTIAL_STATES, value.credentials)
  );
}

export function isMessagingThreadSummary(value: unknown): value is MessagingThreadSummary {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.linkId) &&
    isBoundedString(value.title, MESSAGING_LIMITS.name) &&
    isBoolean(value.isDirect) &&
    isBoundedString(value.updatedAt, 64)
  );
}

export function isMessagingOverview(value: unknown): value is MessagingOverview {
  return (
    isDynamicRecord(value) &&
    (value.connection === null || isMessagingConnection(value.connection)) &&
    Array.isArray(value.threads) &&
    value.threads.length <= MESSAGING_LIMITS.threads &&
    value.threads.every(isMessagingThreadSummary)
  );
}

function isMessagingThreadMessage(value: unknown): value is MessagingThreadMessage {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(["external", "agent"] as const, value.role) &&
    isNullableBoundedString(value.authorName, MESSAGING_LIMITS.name) &&
    isBoundedString(value.text, MESSAGING_LIMITS.messageText) &&
    isBoundedString(value.createdAt, 64)
  );
}

export function isMessagingThread(value: unknown): value is MessagingThread {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.linkId) &&
    isBoundedString(value.title, MESSAGING_LIMITS.name) &&
    Array.isArray(value.messages) &&
    value.messages.length <= MESSAGING_LIMITS.threadMessages &&
    value.messages.every(isMessagingThreadMessage)
  );
}

export function isSlackSetup(value: unknown): value is SlackSetup {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.manifestJson, MESSAGING_LIMITS.manifest) &&
    isString(value.createAppUrl) &&
    value.createAppUrl.length <= MESSAGING_LIMITS.url &&
    value.createAppUrl.startsWith("https://api.slack.com/")
  );
}

// The replies of a host's `messaging-v1` routes, as the desktop main process and the browser client
// read them. The route codec has already checked their bounds; these give them their IPC types and
// fail closed on anything else. The preload has its own decoders.

export function decodeMessagingOverview(value: unknown): MessagingOverview {
  if (!isMessagingOverview(value)) throw new Error("Invalid messaging overview.");
  return value;
}

export function decodeSlackSetup(value: unknown): SlackSetup {
  if (!isSlackSetup(value)) throw new Error("Invalid Slack setup.");
  return value;
}

export function decodeMessagingThread(value: unknown): MessagingThread {
  if (!isMessagingThread(value)) throw new Error("Invalid messaging thread.");
  return value;
}
