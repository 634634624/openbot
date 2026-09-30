// @vitest-environment node

// End to end on the host half of a managed Slack app: the real `SlackIngress` socket, the messaging
// core with its Events API transport, and `AgentService` with its SQLite database. Signal and Slack
// are local fakes: Signal is a WebSocket server that speaks the `ingress` frames, and Slack is one
// HTTP server that checks the request URL while it creates an app, as Slack does. The Signal route
// itself is tested in `remote/api/test/app.test.ts`. Only the provider is faked, as in every agent
// service test. Writes .openbot-build/slack-managed-e2e/report.json.

import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sealSlackWorkspaceGrant } from "@openbot/contracts/slack-workspace-grant";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentService } from "../backend/agent-service";
import {
  startAgentTestFixture,
  startService,
  stopAgentTestFixture,
  waitFor,
} from "../backend/agent-service-test-harness";
import { type MessagingCredentials, MessagingService } from "../backend/messaging/messaging-service";
import { slackDriver } from "../backend/messaging/slack/slack-driver";
import { SLACK_BOT_SCOPES } from "../backend/messaging/slack/slack-manifest";
import { SlackIngress } from "./slack-ingress";

const REPORT_DIR = resolve(import.meta.dirname, "../../.openbot-build/slack-managed-e2e");
const MANAGER_TOKEN = "xoxp-1-manager-token";
const BOT_TOKEN = "xoxb-9999-8888-managedbottoken";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const CLIENT_SECRET = "client-secret-managed";
const REQUEST_URL = "https://signal.example.test/v1/slack/events/route-token";

interface Answer {
  status: number;
  contentType?: string;
  body?: string;
}

/** Signal's side of the `ingress` socket: it takes the host's hello and passes Slack requests on. */
class FakeSignal {
  readonly hellos: DynamicRecord[] = [];
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  readonly #answers = new Map<string, (answer: Answer) => void>();
  url = "";

  async start(): Promise<void> {
    this.#server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.#server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (!isDynamicRecord(frame)) return;
        if (frame.type === "hello") {
          this.hellos.push(frame);
          this.#socket = socket;
          socket.send(
            JSON.stringify({ type: "ready", version: 1, connectionId: null, resumeToken: "r", iceServers: [] }),
          );
        } else if (frame.type === "slack-delivery-result" && isString(frame.requestId)) {
          this.#answers.get(frame.requestId)?.({
            status: Number(frame.status),
            ...(isString(frame.contentType) ? { contentType: frame.contentType } : {}),
            ...(isString(frame.body) ? { body: frame.body } : {}),
          });
        }
      });
    });
    await new Promise<void>((resolve) => this.#server?.once("listening", resolve));
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("The fake Signal has no port.");
    this.url = `ws://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.#server?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  /** One Slack request, as Signal passes it to the host, and the host's answer. */
  deliver(input: { connectionId: string; body: string; signature: string; timestamp: string }): Promise<Answer> {
    const socket = this.#socket;
    if (!socket) throw new Error("The host has no ingress socket.");
    const requestId = randomUUID().replaceAll("-", "");
    return new Promise((resolve) => {
      this.#answers.set(requestId, resolve);
      socket.send(
        JSON.stringify({
          type: "slack-delivery",
          version: 1,
          requestId,
          connectionId: input.connectionId,
          kind: "events",
          timestamp: input.timestamp,
          signature: input.signature,
          retryNum: null,
          retryReason: null,
          bodyBase64: Buffer.from(input.body).toString("base64"),
        }),
      );
    });
  }
}

/** Slack's Web API for the manager app, the agent's app and its bot. */
class FakeSlack {
  readonly calls: Array<{ method: string; params: Record<string, string> }> = [];
  urlCheck: Answer | null = null;
  #server: Server | null = null;
  #ts = 1000;
  origin = "";

  constructor(
    readonly signal: FakeSignal,
    readonly connectionId: () => string,
  ) {}

  async start(): Promise<void> {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = (request.url ?? "").replace("/api/", "");
      const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      this.calls.push({ method, params });
      const token = request.headers.authorization?.replace("Bearer ", "");
      const reply = (value: DynamicRecord, headers: Record<string, string> = {}) => {
        for (const [name, header] of Object.entries(headers)) response.setHeader(name, header);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, ...value }));
      };
      const fail = (error: string) => response.end(JSON.stringify({ ok: false, error }));
      switch (method) {
        case "apps.manifest.create": {
          if (token !== MANAGER_TOKEN) return fail("invalid_auth");
          // Slack checks the request URL before it answers, without a signature the host can check.
          const challenge = randomUUID();
          this.urlCheck = await this.signal.deliver({
            connectionId: this.connectionId(),
            body: JSON.stringify({ type: "url_verification", challenge, token: "legacy" }),
            signature: `v0=${"0".repeat(64)}`,
            timestamp: String(Math.floor(Date.now() / 1_000)),
          });
          if (this.urlCheck.body !== challenge) return fail("invalid_manifest");
          return reply({
            app_id: "A9",
            credentials: { client_id: "client-9", client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET },
            oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=client-9",
          });
        }
        case "apps.icon.set":
        case "apps.manifest.update":
        case "apps.manifest.delete":
        case "auth.revoke":
          return token === MANAGER_TOKEN ? reply({}) : fail("invalid_auth");
        case "oauth.v2.access":
          if (params.client_id !== "client-9" || params.client_secret !== CLIENT_SECRET || params.code !== "code-1")
            return fail("invalid_code");
          return reply({ access_token: BOT_TOKEN, token_type: "bot", app_id: "A9", team: { id: "T1" } });
        default:
          break;
      }
      if (token !== BOT_TOKEN) return fail("invalid_auth");
      switch (method) {
        case "auth.test":
          return reply(
            { team_id: "T1", team: "Test workspace", user_id: "UBOT", bot_id: "B9" },
            { "x-oauth-scopes": SLACK_BOT_SCOPES.join(",") },
          );
        case "bots.info":
          return reply({ bot: { app_id: "A9" } });
        case "users.info":
          return reply({ user: { name: "alice", profile: { display_name: "Alice" } } });
        case "conversations.info":
          return reply({ channel: { name: "general" } });
        case "conversations.replies":
        case "conversations.history":
          return reply({ messages: [] });
        case "chat.postMessage":
          this.#ts += 1;
          return reply({ ts: `${this.#ts}.000` });
        case "conversations.list":
          return params.cursor
            ? reply({ channels: [{ id: "C3", is_member: false }], response_metadata: { next_cursor: "" } })
            : reply({
                channels: [
                  { id: "C1", is_member: false },
                  { id: "C2", is_member: true },
                ],
                response_metadata: { next_cursor: "page-2" },
              });
        default:
          return reply({});
      }
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("The fake Slack has no port.");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  of(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
}

class MemoryCredentials implements MessagingCredentials {
  readonly values = new Map<string, Record<string, string>>();
  keys() {
    return [...this.values.keys()];
  }
  status(key: string) {
    return this.values.has(key) ? ("saved" as const) : ("missing" as const);
  }
  get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, values: Record<string, string>) {
    this.values.set(key, values);
  }
  async clear(key: string) {
    this.values.delete(key);
  }
  async retain(keys: ReadonlySet<string>) {
    for (const key of [...this.values.keys()]) if (!keys.has(key)) this.values.delete(key);
  }
}

function signed(body: string, timestamp = String(Math.floor(Date.now() / 1_000)), secret = SIGNING_SECRET) {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { body, signature, timestamp };
}

let root = "";
let service: AgentService | null = null;
let messaging: MessagingService | null = null;
let ingress: SlackIngress | null = null;
let signal: FakeSignal;
let slack: FakeSlack;
let connectionId = "";

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
  signal = new FakeSignal();
  await signal.start();
  slack = new FakeSlack(signal, () => connectionId);
  await slack.start();
});

afterEach(async () => {
  await messaging?.stop();
  messaging = null;
  ingress?.dispose();
  ingress = null;
  await slack.stop();
  await signal.stop();
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("Managed Slack app end to end", () => {
  it("creates the agent's own app, installs it, and answers only requests that Slack signed", async () => {
    const started = await startService(root, { provider: "codex", autoComplete: true });
    service = started.service;
    const agent: AgentSummary = await started.store.getOrCreate("slack-agent");
    const credentials = new MemoryCredentials();
    const authorizations: Array<{ hostNonce: string; hostPublicKey: string }> = [];
    const opened: string[] = [];
    let requestUrl = REQUEST_URL;
    ingress = new SlackIngress({
      hostId: () => "host-1",
      signedIn: () => true,
      issueTicket: async () => ({ ticket: "ticket-1", signalUrl: signal.url }),
      issueRequestUrl: async (_hostId, id) => {
        connectionId = id;
        return requestUrl;
      },
    });
    const slackIngress = ingress;
    const createMessaging = () =>
      new MessagingService({
        threads: started.service.messaging,
        agents: {
          listAgents: () => started.service.listAgents(),
          respondToApproval: (input) => started.service.respondToApproval(input),
          onEvent: (listener) => {
            started.service.on("event", listener);
            return () => started.service.off("event", listener);
          },
        },
        credentials,
        drivers: [slackDriver({ origin: slack.origin, ingress: slackIngress })],
        downloadsRoot: join(root, "messaging-downloads"),
        ingress: slackIngress,
        slackManager: {
          authorize: async (input) => {
            authorizations.push(input);
            return "https://slack.com/oauth/v2/authorize?client_id=manager";
          },
          installRedirectUrl: () => "https://openbot.run/slack/connect",
          openExternal: async (url) => {
            opened.push(url);
          },
        },
        slackOrigin: slack.origin,
      });
    messaging = createMessaging();
    await messaging.start();

    // The workspace: the manager token comes back sealed to this sign-in's key.
    await messaging.connectSlackWorkspace();
    const [authorization] = authorizations;
    if (!authorization) throw new Error("The workspace sign-in did not start.");
    const grant = await sealSlackWorkspaceGrant(authorization.hostPublicKey, authorization.hostNonce, {
      accessToken: MANAGER_TOKEN,
      workspaceId: "T1",
      workspaceName: "Test workspace",
      userId: "UADMIN",
    });
    expect(await messaging.completeSlackWorkspace("another-nonce", grant)).toBe(false);
    expect(await messaging.completeSlackWorkspace(authorization.hostNonce, grant)).toBe(true);
    expect(messaging.overview(agent.id).slackWorkspaces).toEqual([{ workspaceId: "T1", name: "Test workspace" }]);

    // The app: Slack checks the request URL while it creates it, then the install page opens.
    const created = await messaging.createSlackApp({ agentId: agent.id, workspaceId: "T1" });
    expect(created.connection).toMatchObject({ state: "awaiting_install" });
    expect(signal.hellos).toEqual([{ type: "hello", version: 1, peer: "ingress", token: "ticket-1" }]);
    const manifest = JSON.parse(slack.of("apps.manifest.create")[0]?.params.manifest ?? "{}");
    expect(manifest.settings).toMatchObject({
      socket_mode_enabled: false,
      event_subscriptions: { request_url: REQUEST_URL },
      interactivity: { request_url: REQUEST_URL },
    });
    expect(manifest.features.bot_user.display_name).toBe(agent.name);
    const install = new URL(opened.at(-1) ?? "");
    const state = install.searchParams.get("state") ?? "";
    expect(install.searchParams.get("client_id")).toBe("client-9");

    expect(await messaging.completeSlackInstall("another-state", "code-1")).toBe(false);
    expect(await messaging.completeSlackInstall(state, "code-1")).toBe(true);
    await waitFor(() => messaging?.overview(agent.id).connection?.state === "connected");

    // Events: a signed mention runs the agent once, however often Slack sends it.
    const mention = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A9",
      event_id: "Ev1",
      event: { type: "app_mention", user: "UALICE", text: "<@UBOT> hello", ts: "100.000", channel: "C1" },
    });
    expect(await signal.deliver({ connectionId, ...signed(mention) })).toEqual({ status: 200 });
    expect(await signal.deliver({ connectionId, ...signed(mention) })).toEqual({ status: 200 });
    await waitFor(() => slack.of("chat.update").some((call) => call.params.text === "CODEX_DONE"));
    const turns = started.client.requests.filter((request) => request.method === "turn/start");
    expect(turns).toHaveLength(1);

    // The app's icon is the agent's avatar. Slack allows about one icon a minute, so the same one is
    // not sent again.
    const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await messaging.setSlackIcon(agent.id, icon);
    await messaging.setSlackIcon(agent.id, icon);
    expect(slack.of("apps.icon.set")).toHaveLength(1);

    // The agent is in every public channel without an invitation, and in each new one.
    await waitFor(() => slack.of("conversations.join").length === 2);
    expect(slack.of("conversations.join").map((call) => call.params.channel)).toEqual(["C1", "C3"]);
    const channelCreated = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A9",
      event_id: "Ev2",
      event: { type: "channel_created", channel: { id: "C4", name: "launch" } },
    });
    expect(await signal.deliver({ connectionId, ...signed(channelCreated) })).toEqual({ status: 200 });
    await waitFor(() => slack.of("conversations.join").some((call) => call.params.channel === "C4"));

    // Anything Slack did not sign with this app's secret, or signed too long ago, is refused.
    const forged = await signal.deliver({ connectionId, ...signed(mention, undefined, "f".repeat(32)) });
    const stale = await signal.deliver({
      connectionId,
      ...signed(mention, String(Math.floor(Date.now() / 1_000) - 600)),
    });
    const unknown = await signal.deliver({ connectionId: "messaging-unknown", ...signed(mention) });
    expect([forged.status, stale.status, unknown.status]).toEqual([401, 401, 404]);

    // A restart behind a new Signal address, such as a new tunnel, moves the app to it.
    await messaging.stop();
    requestUrl = "https://moved-signal.example.test/v1/slack/events/route-token-2";
    messaging = createMessaging();
    await messaging.start();
    await messaging.syncSlackApps();
    await waitFor(() => slack.of("apps.manifest.update").length === 1);
    const moved = JSON.parse(slack.of("apps.manifest.update")[0]?.params.manifest ?? "{}");
    expect(moved.settings.event_subscriptions.request_url).toBe(requestUrl);
    await waitFor(() => messaging?.overview(agent.id).connection?.state === "connected");

    // Disconnect deletes the app that OpenBot made, with the workspace's manager token.
    await messaging.disconnect(agent.id);
    expect(slack.of("apps.manifest.delete").map((call) => call.params.app_id)).toEqual(["A9"]);
    expect(credentials.get(connectionId)).toBeNull();

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, "report.json"),
      `${JSON.stringify(
        {
          urlCheck: slack.urlCheck?.status,
          installedState: "connected",
          turns: turns.length,
          refused: { forged: forged.status, stale: stale.status, unknown: unknown.status },
          deletedApps: slack.of("apps.manifest.delete").length,
        },
        null,
        2,
      )}\n`,
    );
  });
});
