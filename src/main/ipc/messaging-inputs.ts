// The messaging payloads. No message here quotes the input.

import type {
  CreateSlackAppInput,
  MessagingAgentInput,
  ReadMessagingThreadInput,
  SetMessagingEnabledInput,
  SetSlackIconInput,
  SlackWorkspaceInput,
} from "@openbot/contracts/ipc";
import { isBoolean } from "@openbot/contracts/runtime-values";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export function parseMessagingAgentInput(value: unknown): MessagingAgentInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id") };
}

export function parseSlackWorkspaceInput(value: unknown): SlackWorkspaceInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id") };
}

export function parseCreateSlackAppInput(value: unknown): CreateSlackAppInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return {
    agentId: requireString(value.agentId, "Agent id"),
    workspaceId: requireString(value.workspaceId, "Workspace id"),
  };
}

export function parseSetSlackIconInput(value: unknown): SetSlackIconInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const image = parseAvatarImage(value.image);
  if (image?.mimeType !== "image/png") throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id"), image };
}

export function parseSetMessagingEnabledInput(value: unknown): SetMessagingEnabledInput {
  if (!isObject(value) || !isBoolean(value.enabled)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id"), enabled: value.enabled };
}

export function parseReadMessagingThreadInput(value: unknown): ReadMessagingThreadInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { agentId: requireString(value.agentId, "Agent id"), linkId: requireString(value.linkId, "Thread id") };
}
