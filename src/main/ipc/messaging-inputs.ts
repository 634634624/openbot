// The messaging payloads. `connectSlack` carries two tokens, so no message here quotes the input.
// The Slack driver checks the token format again and says which token is wrong.

import type {
  ConnectSlackInput,
  MessagingAgentInput,
  ReadMessagingThreadInput,
  SetMessagingEnabledInput,
} from "@openbot/contracts/ipc";
import { MESSAGING_LIMITS } from "@openbot/contracts/ipc";
import { isBoolean, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { isObject, requireString } from "./validation";

export function parseMessagingAgentInput(value: unknown): MessagingAgentInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id") };
}

export function parseConnectSlackInput(value: unknown): ConnectSlackInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const token = (candidate: unknown, error: string) => {
    if (!isString(candidate) || !candidate.trim() || candidate.length > MESSAGING_LIMITS.token) throw new Error(error);
    return candidate.trim();
  };
  return {
    agentId: requireString(value.agentId, "Agent id"),
    botToken: token(value.botToken, sourceText("error.messaging.botTokenInvalid")),
    appToken: token(value.appToken, sourceText("error.messaging.appTokenInvalid")),
  };
}

export function parseSetMessagingEnabledInput(value: unknown): SetMessagingEnabledInput {
  if (!isObject(value) || !isBoolean(value.enabled)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id"), enabled: value.enabled };
}

export function parseReadMessagingThreadInput(value: unknown): ReadMessagingThreadInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id"), linkId: requireString(value.linkId, "Thread id") };
}
