import type { RemoteAuthEvent } from "@openbot/contracts/signal-protocol/auth-events";
import { Elysia } from "elysia";
import { z } from "zod";
import type { RemoteApiConfig } from "./config";
import { SLACK_DELIVERY_BODY_BYTES_LIMIT, type SlackDeliveryKind } from "./protocol";
import type { SignalService, SignalSocket, SlackDeliveryResponse } from "./signal-service";
import { type SlackRouteVerifier, verifyWebhookSignature } from "./tokens";

const SLACK_SIGNATURE_PATTERN = /^v0=[0-9a-f]{64}$/u;
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SLACK_RETRY_REASON_PATTERN = /^[a-z0-9_]{1,64}$/u;

const authEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("account-profile-changed"), userId: z.string().min(1) }),
  z.object({ type: z.literal("account-servers-changed"), userId: z.string().min(1) }),
  z.object({
    type: z.literal("remote-auth-changed"),
    hostId: z.string().min(1),
    authEpoch: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("remote-session-ended"),
    hostId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]) satisfies z.ZodType<RemoteAuthEvent>;

export function createRemoteApiApp(config: RemoteApiConfig, signal: SignalService, routes: SlackRouteVerifier) {
  const app = new Elysia()
    .get("/health/live", () => ({ service: "openbot-remote-api", status: "live" }))
    .get("/health/ready", () => ({ service: "openbot-remote-api", status: "ready" }))
    .post("/internal/auth-events", async ({ request, set }) => {
      const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
      const signature = request.headers.get("OpenBot-Signature") ?? "";
      const body = await request.text();
      if (!verifyWebhookSignature(body, timestamp, signature, config.authWebhookSecret)) {
        set.status = 401;
        return { error: { code: "invalid_signature", message: "The auth event signature is invalid." } };
      }
      const event = decodeAuthEvent(body);
      if (!event) {
        set.status = 400;
        return { error: { code: "invalid_event", message: "The auth event is invalid." } };
      }
      if (event.type === "remote-auth-changed") signal.revoke(event.hostId, event.authEpoch);
      else if (event.type === "account-profile-changed") signal.profileChanged(event.userId);
      else if (event.type === "account-servers-changed") signal.serversChanged(event.userId);
      else signal.revokeSession(event.sessionId);
      return new Response(null, { status: 204 });
    })
    // A managed Slack app's request URL, for events and button presses. Signal checks only what it
    // can check cheaply, finds the host from the route token, and passes the exact body to that
    // host's ingress socket. The host checks Slack's signature. Nothing here logs the path, which
    // holds the route token, or the body.
    .post(
      "/v1/slack/events/:route",
      async ({ request, params, server }) => {
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (!Number.isFinite(declaredLength) || declaredLength > SLACK_DELIVERY_BODY_BYTES_LIMIT) {
          return slackResponse({ status: 413 });
        }
        const kind = slackDeliveryKind(request.headers.get("content-type"));
        if (!kind) return slackResponse({ status: 415 });
        const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
        const signature = request.headers.get("x-slack-signature") ?? "";
        if (!freshSlackTimestamp(timestamp) || !SLACK_SIGNATURE_PATTERN.test(signature)) {
          return slackResponse({ status: 401 });
        }
        let route: Awaited<ReturnType<SlackRouteVerifier["verifySlackRoute"]>>;
        try {
          route = await routes.verifySlackRoute(params.route);
        } catch {
          const address = signalClientIp(
            server?.requestIP(request)?.address,
            request.headers.get("x-forwarded-for"),
            config.trustProxy,
          );
          return slackResponse({ status: signal.acceptSlackRequest(`address:${address}`) ? 404 : 429 });
        }
        if (!signal.acceptSlackRequest(`route:${route.connectionId}`)) return slackResponse({ status: 429 });
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > SLACK_DELIVERY_BODY_BYTES_LIMIT) return slackResponse({ status: 413 });
        const retryNum = Number(request.headers.get("x-slack-retry-num") ?? "");
        const retryReason = request.headers.get("x-slack-retry-reason");
        return slackResponse(
          await signal.deliverSlack(route.hostId, {
            connectionId: route.connectionId,
            kind,
            timestamp,
            signature,
            retryNum: Number.isInteger(retryNum) && retryNum >= 0 && retryNum < 100 ? retryNum : null,
            retryReason: retryReason && SLACK_RETRY_REASON_PATTERN.test(retryReason) ? retryReason : null,
            body,
          }),
        );
      },
      { parse: "none" },
    )
    .ws("/v1/signal", {
      idleTimeout: 120,
      maxPayloadLength: 64 * 1024,
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      sendPings: true,
      open(ws) {
        signal.connect(socketAdapter(ws, config.trustProxy));
      },
      async message(ws, message) {
        const socket = socketAdapter(ws, config.trustProxy);
        const textMessage = z.string().safeParse(message);
        const input = textMessage.success
          ? textMessage.data
          : message instanceof Uint8Array
            ? message
            : JSON.stringify(message);
        await signal.receive(socket, input);
      },
      close(ws) {
        signal.disconnect(socketAdapter(ws, config.trustProxy));
      },
      error({ error }) {
        console.error("Remote signal WebSocket failed.", error instanceof Error ? error.message : "Unknown error");
      },
    });
  return app;
}

interface ElysiaSocketLike {
  id: string;
  data?: { request?: Request };
  remoteAddress?: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

function socketAdapter(ws: ElysiaSocketLike, trustProxy: boolean): SignalSocket {
  return {
    id: ws.id,
    ip: signalClientIp(ws.remoteAddress, ws.data?.request?.headers.get("x-forwarded-for"), trustProxy),
    send: (message) => {
      ws.send(message);
    },
    close: (code, reason) => ws.close(code, reason.slice(0, 123)),
  };
}

export function signalClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: boolean,
) {
  if (!trustProxy) return remoteAddress ?? "unknown";
  const forwarded = forwardedFor?.split(",", 1)[0]?.trim();
  return forwarded || remoteAddress || "unknown";
}

function slackDeliveryKind(contentType: string | null): SlackDeliveryKind | null {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json") return "events";
  if (mediaType === "application/x-www-form-urlencoded") return "interactivity";
  return null;
}

// A cheap filter only. The host checks the timestamp again, with the signature that covers it.
function freshSlackTimestamp(timestamp: string, nowSeconds = Math.floor(Date.now() / 1_000)): boolean {
  if (!/^[0-9]{1,12}$/u.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= SLACK_TIMESTAMP_TOLERANCE_SECONDS;
}

function slackResponse(response: SlackDeliveryResponse | { status: 413 | 415 | 429 | 401 | 404 }): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if ("contentType" in response && response.contentType && response.body !== undefined) {
    headers["Content-Type"] = response.contentType;
    return new Response(response.body, { status: response.status, headers });
  }
  return new Response(null, { status: response.status, headers });
}

function decodeAuthEvent(body: string): RemoteAuthEvent | null {
  try {
    const result = authEventSchema.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function prometheusMetrics(signal: SignalService): string {
  const metrics = signal.metrics();
  return [
    "# TYPE openbot_remote_signal_sockets gauge",
    `openbot_remote_signal_sockets ${metrics.activeSockets}`,
    "# TYPE openbot_remote_peer_connections gauge",
    `openbot_remote_peer_connections ${metrics.activePeerConnections}`,
    "# TYPE openbot_remote_signal_messages_total counter",
    `openbot_remote_signal_messages_total ${metrics.relayedMessages}`,
    "# TYPE openbot_remote_auth_failures_total counter",
    `openbot_remote_auth_failures_total ${metrics.authenticationFailures}`,
    "# TYPE openbot_remote_protocol_failures_total counter",
    `openbot_remote_protocol_failures_total ${metrics.protocolFailures}`,
    "# TYPE openbot_remote_slack_deliveries_total counter",
    `openbot_remote_slack_deliveries_total ${metrics.slackDeliveries}`,
    "# TYPE openbot_remote_slack_deliveries_unavailable_total counter",
    `openbot_remote_slack_deliveries_unavailable_total ${metrics.slackDeliveriesUnavailable}`,
    "",
  ].join("\n");
}
