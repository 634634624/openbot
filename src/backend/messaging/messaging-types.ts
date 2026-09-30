// The seam between the platform-agnostic messaging core and one chat platform. A platform is one
// `MessagingDriver`: an adapter for its API and a transport for its inbound events. A Slack app that
// the user made uses Socket Mode; a Discord driver would use the Gateway and a Telegram driver long
// polling (`getUpdates`). All of them connect out from the host, so no public endpoint is needed.
// A Slack app that OpenBot manages uses the Events API instead: Slack posts to Signal, and Signal
// passes each request to this host over the `MessagingIngress` socket, which the host also opens.

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
  /** Handles one request that the ingress relay brought, for a transport that gets its events that way. */
  deliver?(delivery: IngressDelivery): Promise<IngressAnswer>;
}

/** One HTTP request that a platform sent to this host's request URL, as Signal passed it on. */
export interface IngressDelivery {
  kind: "events" | "interactivity";
  timestamp: string;
  signature: string;
  retryNum: number | null;
  /** The exact bytes the platform signed. */
  body: Uint8Array;
}

/** The HTTP answer the platform gets. A body only for a URL check or a button reply. */
export interface IngressAnswer {
  status: 200 | 400 | 401 | 404 | 503;
  contentType?: "application/json" | "text/plain";
  body?: string;
}

/** `unavailable` has a reason the user can act on: sign in, name this computer, or wait for Signal. */
export type IngressState = "online" | "connecting" | "signed_out" | "no_host" | "unavailable";

export type IngressHandler = (connectionId: string, delivery: IngressDelivery) => Promise<IngressAnswer>;

/**
 * The relay that brings a platform's HTTP requests to this host: Signal's `ingress` socket, which
 * the main process owns. It is open while anything holds it.
 */
export interface MessagingIngress {
  /** Keeps the relay open until the returned function runs. */
  acquire(): () => void;
  state(): IngressState;
  onState(listener: (state: IngressState) => void): () => void;
  /** Sets the one handler of the requests the relay receives, or removes it. */
  handle(handler: IngressHandler | null): void;
  /** Opens the socket again, such as after the computer wakes. */
  reconnect(): void;
  /** The public request URL that routes to this host, for one connection. */
  requestUrl(connectionId: string): Promise<string>;
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
