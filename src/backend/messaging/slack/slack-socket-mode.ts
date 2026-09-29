import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import WebSocket from "ws";
import {
  type ConnectionIdentity,
  MessagingConnectionError,
  type MessagingTransport,
  type TransportSink,
} from "../messaging-types";
import { slackInboundAction, slackInboundMessage } from "./slack-events";
import { SLACK_API_ORIGIN, SlackWebApi } from "./slack-web-api";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_LIMIT_MS = 60_000;
/** Slack drops an envelope that is not acknowledged in three seconds and sends it again. */
const RECENT_ENVELOPES = 2_000;

export interface SlackSocketModeOptions {
  appToken: string;
  identity: ConnectionIdentity;
  /** Only tests change this. */
  origin?: string;
}

/**
 * The inbound half of a Slack connection: a Socket Mode WebSocket that the host opens, so Slack
 * needs no public URL. It acknowledges each envelope before it hands the payload on, as Slack
 * requires, and it drops an envelope it has already seen.
 *
 * Slack asks a client to reconnect from time to time. The new socket is opened first and the old
 * one is closed when the new one says hello, so no event falls between the two. Events that Slack
 * sends while no socket is open are lost; there is no backfill.
 */
export class SlackSocketMode implements MessagingTransport {
  readonly #api: SlackWebApi;
  readonly #identity: ConnectionIdentity;
  readonly #secureOnly: boolean;
  readonly #seen = new Set<string>();
  #sink: TransportSink | null = null;
  #socket: WebSocket | null = null;
  #retiring: WebSocket | null = null;
  #backoffMs = BACKOFF_START_MS;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: SlackSocketModeOptions) {
    this.#api = new SlackWebApi({ token: options.appToken, origin: options.origin });
    this.#identity = options.identity;
    this.#secureOnly = (options.origin ?? SLACK_API_ORIGIN) === SLACK_API_ORIGIN;
  }

  start(sink: TransportSink): void {
    this.#sink = sink;
    this.#stopped = false;
    void this.#open("connecting");
  }

  reconnect(): void {
    if (this.#stopped || !this.#sink) return;
    this.#clearRetry();
    this.#backoffMs = BACKOFF_START_MS;
    void this.#open("reconnecting");
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearRetry();
    this.#stopPing();
    for (const socket of [this.#socket, this.#retiring]) socket?.close(1000);
    this.#socket = null;
    this.#retiring = null;
  }

  async #open(state: "connecting" | "reconnecting"): Promise<void> {
    this.#sink?.state(state);
    let url: string;
    try {
      const response = await this.#api.call("apps.connections.open");
      if (!isString(response.url)) throw new Error("Slack returned no Socket Mode URL.");
      url = response.url;
      const protocol = new URL(url).protocol;
      if (protocol !== "wss:" && (this.#secureOnly || protocol !== "ws:")) throw new Error("Insecure Socket Mode URL.");
    } catch (error) {
      if (error instanceof MessagingConnectionError) return this.#fail(error.state);
      return this.#scheduleRetry();
    }
    if (this.#stopped) return;
    const socket = new WebSocket(url);
    if (this.#socket) this.#retiring = this.#socket;
    this.#socket = socket;
    socket.on("message", (data) => this.#receive(socket, data.toString()));
    socket.on("pong", () => {
      pongs.set(socket, true);
    });
    socket.on("close", () => {
      if (socket === this.#retiring) this.#retiring = null;
      if (socket !== this.#socket || this.#stopped) return;
      this.#socket = null;
      this.#stopPing();
      this.#scheduleRetry();
    });
    socket.on("error", () => {
      // `close` follows and schedules the retry. The message can carry the URL and its ticket.
    });
  }

  #receive(socket: WebSocket, text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isDynamicRecord(frame) || !isString(frame.type)) return;
    if (isString(frame.envelope_id)) socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    switch (frame.type) {
      case "hello": {
        const info = frame.connection_info;
        if (isDynamicRecord(info) && isString(info.app_id) && info.app_id !== this.#identity.appId) {
          this.#fail("tokens_mismatch");
          return;
        }
        this.#retiring?.close(1000);
        this.#backoffMs = BACKOFF_START_MS;
        this.#startPing(socket);
        this.#sink?.state("connected");
        return;
      }
      case "disconnect":
        if (frame.reason === "link_disabled") {
          this.#fail("socket_mode_off");
          return;
        }
        // `refresh_requested` and `warning`: open the next socket while this one still delivers.
        if (socket === this.#socket) void this.#open("reconnecting");
        return;
      case "events_api":
      case "interactive": {
        if (!isString(frame.envelope_id) || this.#remember(frame.envelope_id)) return;
        const { workspaceId, botUserId } = this.#identity;
        if (frame.type === "events_api") {
          const message = slackInboundMessage(frame.payload, workspaceId, botUserId);
          if (message) this.#sink?.message(message);
        } else {
          const action = slackInboundAction(frame.payload, workspaceId);
          if (action) this.#sink?.action(action);
        }
        return;
      }
      default:
        return;
    }
  }

  /** True when the envelope was already handled. */
  #remember(envelopeId: string): boolean {
    if (this.#seen.has(envelopeId)) return true;
    this.#seen.add(envelopeId);
    if (this.#seen.size > RECENT_ENVELOPES) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return false;
  }

  #fail(state: MessagingConnectionError["state"]): void {
    this.#sink?.state(state);
    void this.stop();
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retry) return;
    this.#sink?.state("reconnecting");
    const delay = this.#backoffMs * (0.5 + Math.random() / 2);
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_LIMIT_MS);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#open("reconnecting");
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  /** A socket can die silently when the computer sleeps. No pong in time closes it, and `close` retries. */
  #startPing(socket: WebSocket): void {
    this.#stopPing();
    this.#ping = setInterval(() => {
      if (socket !== this.#socket) return;
      pongs.set(socket, false);
      socket.ping();
      setTimeout(() => {
        if (pongs.get(socket) === false) socket.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #stopPing(): void {
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
  }
}

const pongs = new WeakMap<WebSocket, boolean>();
