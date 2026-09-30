import { generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createRemoteApiApp, signalClientIp } from "../src/app";
import { readRemoteApiConfig } from "../src/config";
import type { RemoteTicketClaims } from "../src/protocol";
import { type RemoteTokenProvider, SignalService } from "../src/signal-service";
import { RemoteTokenService, signServiceRequest } from "../src/tokens";

describe("Remote API proxy addresses", () => {
  it("uses the first forwarded address only when the proxy is trusted", () => {
    expect(signalClientIp("127.0.0.1", "198.51.100.20, 127.0.0.1", true)).toBe("198.51.100.20");
    expect(signalClientIp("203.0.113.8", "198.51.100.20", false)).toBe("203.0.113.8");
  });
});

describe("Remote API development configuration", () => {
  it("uses the Auth API public JWKS binding for a local Signal service", () => {
    expect(
      readRemoteApiConfig({
        REMOTE_TICKET_PUBLIC_JWKS: '{"keys":[]}',
        REMOTE_TLS_DISABLED: "true",
        REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1:3100",
        REMOTE_SESSION_SECRET: "s".repeat(32),
        REMOTE_AUTH_WEBHOOK_SECRET: "w".repeat(32),
        TURN_SHARED_SECRET: "t".repeat(32),
        TURN_HOST: "192.168.1.143",
      }).ticketJwks,
    ).toBe('{"keys":[]}');
  });
});

describe("signed account notifications", () => {
  it("verifies the exact HTTP body before delivering profile invalidation", async () => {
    const config = readRemoteApiConfig({
      REMOTE_TICKET_JWKS_URL: "https://api.example.test/.well-known/jwks.json",
      REMOTE_TLS_DISABLED: "true",
      REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1:3100",
      REMOTE_SESSION_SECRET: "s".repeat(32),
      REMOTE_AUTH_WEBHOOK_SECRET: "w".repeat(32),
      TURN_SHARED_SECRET: "t".repeat(32),
      TURN_HOST: "localhost",
    });
    const signal = new SignalService(new RemoteTokenService(config), 8);
    const changed = vi.spyOn(signal, "profileChanged");
    const app = createRemoteApiApp(config, signal, new RemoteTokenService(config));
    const body = '{ "type": "account-profile-changed", "userId": "user-1" }';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signServiceRequest(body, timestamp, config.authWebhookSecret);
    const send = (payload: string, signed: string) =>
      app.handle(
        new Request("http://localhost/internal/auth-events", {
          method: "POST",
          headers: { "Content-Type": "application/json", "OpenBot-Timestamp": timestamp, "OpenBot-Signature": signed },
          body: payload,
        }),
      );
    const response = await send(body, signature);
    expect(response.status, await response.text()).toBe(204);
    expect(changed).toHaveBeenCalledWith("user-1");
    changed.mockClear();
    expect((await send(body.replace("user-1", "user-2"), signature)).status).toBe(401);
    expect((await send(body, "")).status).toBe(401);
    expect(changed).not.toHaveBeenCalled();
  });

  it("forwards a changed server list to the account that joined or lost one", async () => {
    const config = readRemoteApiConfig({
      REMOTE_TICKET_JWKS_URL: "https://api.example.test/.well-known/jwks.json",
      REMOTE_TLS_DISABLED: "true",
      REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1:3100",
      REMOTE_SESSION_SECRET: "s".repeat(32),
      REMOTE_AUTH_WEBHOOK_SECRET: "w".repeat(32),
      TURN_SHARED_SECRET: "t".repeat(32),
      TURN_HOST: "localhost",
    });
    const signal = new SignalService(new RemoteTokenService(config), 8);
    const changed = vi.spyOn(signal, "serversChanged");
    const app = createRemoteApiApp(config, signal, new RemoteTokenService(config));
    const body = '{ "type": "account-servers-changed", "userId": "user-1" }';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.handle(
      new Request("http://localhost/internal/auth-events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OpenBot-Timestamp": timestamp,
          "OpenBot-Signature": signServiceRequest(body, timestamp, config.authWebhookSecret),
        },
        body,
      }),
    );
    expect(response.status, await response.text()).toBe(204);
    expect(changed).toHaveBeenCalledWith("user-1");
  });
});

// Slack posts to Signal from the internet, so each refusal here is a security check: nothing reaches
// a host unless Signal's own key signed the route token, and a host gets only the exact bytes Slack
// signed.
describe("Slack request route", () => {
  it("passes a Slack request to the host's ingress socket and returns the host's answer", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "slack-route-1";
    jwk.alg = "ES256";
    const config = readRemoteApiConfig({
      REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [jwk] }),
      REMOTE_TLS_DISABLED: "true",
      REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1:3100",
      REMOTE_SESSION_SECRET: "s".repeat(32),
      REMOTE_AUTH_WEBHOOK_SECRET: "w".repeat(32),
      TURN_SHARED_SECRET: "t".repeat(32),
      TURN_HOST: "localhost",
    });
    const signal = new SignalService(hostTickets(), 8);
    const app = createRemoteApiApp(config, signal, new RemoteTokenService(config));
    const route = (claims: Record<string, string>, audience = "openbot-slack-route") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "slack-route-1" })
        .setAudience(audience)
        .setIssuedAt()
        .sign(privateKey);
    const token = await route({ hid: "host-1", cid: "messaging-1" });
    const body = '{"type":"url_verification","challenge":"abc"}';
    const post = (path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
      app.handle(
        new Request(`http://localhost/v1/slack/events/${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1_000)),
            "X-Slack-Signature": `v0=${"a".repeat(64)}`,
            ...init.headers,
          },
          body: init.body ?? body,
        }),
      );

    expect((await post(token)).status).toBe(503);
    expect((await post(await route({ hid: "host-1", cid: "messaging-1" }, "openbot-remote"))).status).toBe(404);
    expect((await post("not-a-token")).status).toBe(404);
    expect((await post(token, { headers: { "X-Slack-Request-Timestamp": "1" } })).status).toBe(401);
    expect((await post(token, { headers: { "X-Slack-Signature": "v1=abc" } })).status).toBe(401);
    expect((await post(token, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await post(token, { body: "x".repeat(64 * 1024 + 1) })).status).toBe(413);

    const ingress = testSocket("ingress");
    signal.connect(ingress);
    await signal.receive(ingress, JSON.stringify({ type: "hello", version: 1, peer: "ingress", token: "host-ticket" }));
    ingress.messages.length = 0;

    const pending = post(token);
    await vi.waitFor(() => expect(ingress.messages).toHaveLength(1));
    const delivery = JSON.parse(ingress.messages[0] ?? "{}");
    expect(delivery).toMatchObject({ type: "slack-delivery", connectionId: "messaging-1", kind: "events" });
    expect(Buffer.from(delivery.bodyBase64, "base64").toString()).toBe(body);

    // Another socket of the same host cannot answer a request that Signal did not send it.
    const other = testSocket("other");
    signal.connect(other);
    await signal.receive(other, JSON.stringify({ type: "hello", version: 1, peer: "ingress", token: "host-ticket" }));
    const answer = {
      type: "slack-delivery-result",
      version: 1,
      requestId: delivery.requestId,
      status: 200,
      contentType: "text/plain",
      body: "abc",
    };
    await signal.receive(other, JSON.stringify(answer));
    expect(other.messages.at(-1)).toContain('"code":"permission_denied"');

    await signal.receive(ingress, JSON.stringify(answer));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
  });
});

interface TestSocket {
  id: string;
  ip: string;
  messages: string[];
  send(message: string): void;
  close(): void;
}

function testSocket(id: string): TestSocket {
  const messages: string[] = [];
  return { id, ip: "192.0.2.1", messages, send: (message) => messages.push(message), close: () => {} };
}

function hostTickets(): RemoteTokenProvider {
  const now = Math.floor(Date.now() / 1_000);
  const claims: RemoteTicketClaims = {
    aud: "openbot-remote",
    jti: "host-jti",
    sessionId: "host-session",
    hostId: "host-1",
    userId: "owner-1",
    membershipId: "host-1:host",
    role: "host",
    authEpoch: 1,
    protocolMinimum: 2,
    protocolMaximum: 2,
    sessionExpiresAt: now + 86_400,
    iat: now,
    exp: now + 300,
  };
  return {
    verifyTicket: async () => ({ ...claims, jti: crypto.randomUUID() }),
    verifyResumeToken: async () => claims,
    validateClaims: async () => true,
    issueResumeToken: async () => "resume-host",
    iceServers: () => [],
  };
}
