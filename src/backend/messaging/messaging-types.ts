// The seam between the platform-agnostic messaging core and one chat platform. A platform is one
// `MessagingDriver`: an adapter for its API and a transport for its inbound events. Slack uses
// Socket Mode; a Discord driver would use the Gateway and a Telegram driver long polling
// (`getUpdates`). All three connect out from the host, so no public endpoint is needed.

import type { MessagingConnectionState, MessagingPlatform } from "@openbot/contracts/ipc";
import type { MessagingAnswerFile } from "./messaging-threads";

/** Where a post goes: a platform channel, and the thread in it or the top level. */
export interface MessageTarget {
  platformChannelId: string;
  replyThreadId: string | null;
}

export interface InboundFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

/** One message that addresses the agent, in the same shape for every platform. */
export interface InboundMessage {
  /** Stable for one message across redeliveries. */
  dedupKey: string;
  platformChannelId: string;
  /** Names the conversation: one link, and so one execution thread, per key and channel. */
  threadKey: string;
  target: MessageTarget;
  platformMessageId: string;
  isDirect: boolean;
  /** True for a reply that does not name the agent: it counts only in a conversation it already has. */
  requiresLink: boolean;
  authorId: string;
  text: string;
  files: InboundFile[];
}

export type InboundAction =
  | {
      type: "approval";
      token: string;
      decision: "accept" | "decline";
      actorId: string;
      target: MessageTarget;
      platformMessageId: string;
    }
  | { type: "stop"; token: string; actorId: string; target: MessageTarget; platformMessageId: string };

export interface MessageButton {
  action: "accept" | "decline" | "stop";
  label: string;
  /** Opaque and single use. It maps to the request only in the host's memory. */
  token: string;
  style?: "primary" | "danger";
}

export interface MessageBody {
  text: string;
  buttons?: MessageButton[];
}

export type StatusReaction = "received" | "done" | "failed" | "stopped";

export interface ConnectionIdentity {
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
  appId: string;
  missingScopes: string[];
}

export interface ContextEntry {
  id: string;
  authorName: string;
  text: string;
  sentAt: string;
}

/** A failure the connection cannot recover from alone. The user must act. */
export class MessagingConnectionError extends Error {
  constructor(
    readonly state: Extract<MessagingConnectionState, "invalid_token" | "tokens_mismatch" | "socket_mode_off">,
  ) {
    super(state);
  }
}

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  identify(): Promise<ConnectionIdentity>;
  post(target: MessageTarget, body: MessageBody): Promise<string>;
  edit(target: MessageTarget, messageId: string, body: MessageBody): Promise<void>;
  postPrivate(target: MessageTarget, userId: string, text: string): Promise<void>;
  react(target: MessageTarget, messageId: string, reaction: StatusReaction, on: boolean): Promise<void>;
  /**
   * Posts the agent's answer, in as many posts as the platform needs. The first part replaces
   * `replaceMessageId` when it is given.
   */
  postAnswer(target: MessageTarget, markdown: string, replaceMessageId: string | null): Promise<void>;
  /** Uploads files to the conversation, and returns the names it did not send. */
  upload(target: MessageTarget, files: MessagingAnswerFile[]): Promise<string[]>;
  /** Earlier messages of the conversation, oldest first, after `afterId` and before `beforeId`. */
  history(
    platformChannelId: string,
    threadKey: string,
    afterId: string | null,
    beforeId: string,
  ): Promise<ContextEntry[]>;
  /** Downloads one file to `destination`. Refuses a file larger than `maxBytes`. */
  download(file: InboundFile, destination: string, maxBytes: number): Promise<void>;
  authorName(userId: string): Promise<string>;
  placeName(platformChannelId: string): Promise<string>;
  mention(userId: string): string;
}

export interface TransportSink {
  state(state: MessagingConnectionState, detail?: { retryAt?: string }): void;
  message(message: InboundMessage): void;
  action(action: InboundAction): void;
}

export interface MessagingTransport {
  start(sink: TransportSink): void;
  /** Reconnects now, such as after the computer wakes. */
  reconnect(): void;
  stop(): Promise<void>;
}

export interface MessagingDriverOptions {
  /** Called when the platform asks the host to wait, with the time it can try again. */
  rateLimited(retryAt: string): void;
}

export interface MessagingDriver {
  readonly platform: MessagingPlatform;
  /** Checks the format of the credentials the user entered. Throws a user-readable error. */
  validateCredentials(credentials: Record<string, string>): void;
  createAdapter(credentials: Record<string, string>, options: MessagingDriverOptions): MessagingAdapter;
  createTransport(credentials: Record<string, string>, identity: ConnectionIdentity): MessagingTransport;
}
