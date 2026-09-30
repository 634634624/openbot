import { createHmac, timingSafeEqual } from "node:crypto";
import { SLACK_ROUTE_AUDIENCE } from "@openbot/contracts/signal-protocol/slack-route";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  type FetchImplementation,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  jwtVerify,
  type RemoteJWKSet,
  SignJWT,
} from "jose";
import { z } from "zod";
import type { RemoteApiConfig } from "./config";
import {
  type IceServer,
  REMOTE_TICKET_AUDIENCE,
  REMOTE_TICKET_PROTOCOL_VERSION,
  type RemoteTicketClaims,
  SIGNAL_TURN_CREDENTIAL_TTL_SECONDS,
} from "./protocol";

// The resume token is this service's own, minted and verified here and never seen by the account
// API, so its audience stays local while the ticket's comes from the shared contract.
const RESUME_AUDIENCE = "openbot-remote-resume";
export const RESUME_TTL_SECONDS = 10 * 60;
const MAXIMUM_STALE_RESUME_SECONDS = 24 * 60 * 60;
const MAXIMUM_TRUSTED_RESUME_TOKENS = 100_000;
const MAXIMUM_CACHED_SLACK_ROUTES = 1_000;
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).loose()).min(1) });
const remoteTicketClaimsSchema = z.object({
  aud: z.literal(REMOTE_TICKET_AUDIENCE),
  jti: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  membershipId: z.string().min(1).max(256),
  role: z.enum(["host", "owner", "admin", "member"]),
  authEpoch: z.number().int().nonnegative(),
  protocolMinimum: z.number().int().nonnegative(),
  protocolMaximum: z.number().int().nonnegative(),
  sessionExpiresAt: z.number().int().nonnegative(),
  clientPublicKey: z.string().min(1).max(8_192).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const slackRouteClaimsSchema = z.object({ hid: identifierSchema, cid: identifierSchema });

/** The host and messaging connection that a Slack request URL names. */
export interface SlackRoute {
  hostId: string;
  connectionId: string;
}

export interface SlackRouteVerifier {
  verifySlackRoute(token: string): Promise<SlackRoute>;
}

export class RemoteTokenService implements SlackRouteVerifier {
  readonly #ticketKey: JWTVerifyGetKey;
  readonly #remoteTicketKey: RemoteJWKSet | null;
  readonly #sessionSecret: Uint8Array;
  readonly #turnSecret: string;
  readonly #turnHost: string;
  readonly #turnPort: number;
  readonly #turnTlsPort: number;
  readonly #validateResumeClaims: (claims: RemoteTicketClaims) => Promise<boolean>;
  readonly #trustedResumeTokens = new Map<
    string,
    { expiresAt: number; hostId: string; sessionId: string; authEpoch: number }
  >();
  // Slack sends every event of an app to the same URL, so one ES256 check per token is enough.
  readonly #slackRoutes = new Map<string, SlackRoute>();

  constructor(
    config: Pick<
      RemoteApiConfig,
      "ticketJwks" | "ticketJwksUrl" | "sessionSecret" | "turnSecret" | "turnHost" | "turnPort" | "turnTlsPort"
    >,
    validateResumeClaims: (claims: RemoteTicketClaims) => Promise<boolean> = async () => false,
    options: { fetch?: FetchImplementation } = {},
  ) {
    if (config.ticketJwks) {
      this.#remoteTicketKey = null;
      this.#ticketKey = createLocalJWKSet(parseJwks(config.ticketJwks));
    } else {
      const remoteTicketKey = createRemoteJWKSet(
        new URL(config.ticketJwksUrl ?? invalidJwksConfiguration()),
        options.fetch ? { [customFetch]: options.fetch } : undefined,
      );
      this.#remoteTicketKey = remoteTicketKey;
      this.#ticketKey = remoteTicketKey;
    }
    this.#sessionSecret = new TextEncoder().encode(config.sessionSecret);
    this.#turnSecret = config.turnSecret;
    this.#turnHost = config.turnHost;
    this.#turnPort = config.turnPort;
    this.#turnTlsPort = config.turnTlsPort;
    this.#validateResumeClaims = validateResumeClaims;
  }

  async initialize(): Promise<void> {
    if (!this.#remoteTicketKey) return;
    await this.#remoteTicketKey.reload();
    const jwks = this.#remoteTicketKey.jwks();
    if (!jwks) throw new Error("Ticket JWKS did not load.");
    parseJwks(JSON.stringify(jwks));
  }

  async verifyTicket(token: string, now = new Date()): Promise<RemoteTicketClaims> {
    const { payload } = await jwtVerify(token, this.#ticketKey, {
      audience: REMOTE_TICKET_AUDIENCE,
      algorithms: ["ES256"],
      currentDate: now,
    });
    return decodeTicketClaims(payload, now);
  }

  /**
   * Reads the host and connection from a Slack request URL. The token has no expiry: it only
   * routes, and the host checks Slack's signature on every request it gets.
   */
  async verifySlackRoute(token: string): Promise<SlackRoute> {
    const cached = this.#slackRoutes.get(token);
    if (cached) return cached;
    const { payload } = await jwtVerify(token, this.#ticketKey, {
      audience: SLACK_ROUTE_AUDIENCE,
      algorithms: ["ES256"],
    });
    const claims = slackRouteClaimsSchema.parse(payload);
    const route = { hostId: claims.hid, connectionId: claims.cid };
    if (this.#slackRoutes.size >= MAXIMUM_CACHED_SLACK_ROUTES) {
      const oldest = this.#slackRoutes.keys().next().value;
      if (oldest) this.#slackRoutes.delete(oldest);
    }
    this.#slackRoutes.set(token, route);
    return route;
  }

  validateClaims(claims: RemoteTicketClaims): Promise<boolean> {
    return this.#validateResumeClaims(claims);
  }

  async verifyResumeToken(token: string, now = new Date()): Promise<RemoteTicketClaims> {
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    this.#pruneTrustedResumeTokens(nowSeconds);
    try {
      const { payload } = await jwtVerify(token, this.#sessionSecret, {
        audience: RESUME_AUDIENCE,
        algorithms: ["HS256"],
        currentDate: now,
      });
      const claims = decodeTicketClaims({ ...payload, aud: REMOTE_TICKET_AUDIENCE }, now);
      if (this.#trustedResumeTokens.has(claims.jti)) return claims;
      if (!(await this.#validateResumeClaims(claims))) throw new Error("The remote session is not active.");
      this.#trustResumeToken(claims);
      return claims;
    } catch (error) {
      const claims = await this.#verifyStaleResumeToken(token, now).catch(() => null);
      if (!claims || !(await this.#validateResumeClaims(claims))) throw error;
      return claims;
    }
  }

  async issueResumeToken(claims: RemoteTicketClaims, nowSeconds = Math.floor(Date.now() / 1_000)): Promise<string> {
    const jti = crypto.randomUUID();
    const expiresAt = Math.min(claims.sessionExpiresAt, nowSeconds + RESUME_TTL_SECONDS);
    const token = await new SignJWT({
      sessionId: claims.sessionId,
      hostId: claims.hostId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
      authEpoch: claims.authEpoch,
      protocolMinimum: claims.protocolMinimum,
      protocolMaximum: claims.protocolMaximum,
      sessionExpiresAt: claims.sessionExpiresAt,
      ...(claims.clientPublicKey ? { clientPublicKey: claims.clientPublicKey } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setJti(jti)
      .setIssuedAt(nowSeconds)
      .setAudience(RESUME_AUDIENCE)
      .setExpirationTime(expiresAt)
      .sign(this.#sessionSecret);
    this.#trustResumeToken({ ...claims, jti, iat: nowSeconds, exp: expiresAt });
    return token;
  }

  revokeHost(hostId: string, authEpoch: number): void {
    for (const [jti, token] of this.#trustedResumeTokens) {
      if (token.hostId === hostId && token.authEpoch < authEpoch) this.#trustedResumeTokens.delete(jti);
    }
  }

  revokeSession(sessionId: string): void {
    for (const [jti, token] of this.#trustedResumeTokens) {
      if (token.sessionId === sessionId) this.#trustedResumeTokens.delete(jti);
    }
  }

  #trustResumeToken(claims: RemoteTicketClaims): void {
    this.#pruneTrustedResumeTokens();
    while (this.#trustedResumeTokens.size >= MAXIMUM_TRUSTED_RESUME_TOKENS) {
      const oldest = this.#trustedResumeTokens.keys().next().value;
      if (!oldest) break;
      this.#trustedResumeTokens.delete(oldest);
    }
    this.#trustedResumeTokens.set(claims.jti, {
      expiresAt: claims.exp,
      hostId: claims.hostId,
      sessionId: claims.sessionId,
      authEpoch: claims.authEpoch,
    });
  }

  #pruneTrustedResumeTokens(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    for (const [jti, token] of this.#trustedResumeTokens) {
      if (token.expiresAt <= nowSeconds) this.#trustedResumeTokens.delete(jti);
    }
  }

  async #verifyStaleResumeToken(token: string, now: Date): Promise<RemoteTicketClaims> {
    const untrusted = decodeJwt(token);
    const expiresAt = z.number().int().safe().parse(untrusted.exp);
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (expiresAt >= nowSeconds || nowSeconds - expiresAt > MAXIMUM_STALE_RESUME_SECONDS) {
      throw new Error("The resume token cannot be renewed.");
    }
    const { payload } = await jwtVerify(token, this.#sessionSecret, {
      audience: RESUME_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: new Date((expiresAt - 1) * 1_000),
    });
    const claims = decodeTicketClaims({ ...payload, aud: REMOTE_TICKET_AUDIENCE }, now);
    if (claims.iat > nowSeconds || claims.exp <= claims.iat)
      throw new Error("The resume token timestamps are invalid.");
    return claims;
  }

  iceServers(claims: RemoteTicketClaims, nowSeconds = Math.floor(Date.now() / 1_000)): IceServer[] {
    const expiration = Math.min(claims.sessionExpiresAt, nowSeconds + SIGNAL_TURN_CREDENTIAL_TTL_SECONDS);
    if (expiration <= nowSeconds) throw new Error("The remote session has expired.");
    const username = `${expiration}:${claims.sessionId}`;
    const credential = createHmac("sha1", this.#turnSecret).update(username).digest("base64");
    return [
      { urls: `stun:${this.#turnHost}:${this.#turnPort}` },
      {
        urls: [
          `turn:${this.#turnHost}:${this.#turnPort}?transport=udp`,
          `turn:${this.#turnHost}:${this.#turnPort}?transport=tcp`,
          `turns:${this.#turnHost}:${this.#turnTlsPort}?transport=tcp`,
        ],
        username,
        credential,
      },
    ];
  }
}

export function verifyWebhookSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds * 1_000) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function signServiceRequest(body: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
}

function parseJwks(value: string): JSONWebKeySet {
  return jwksSchema.parse(JSON.parse(value));
}

function decodeTicketClaims(value: unknown, now: Date): RemoteTicketClaims {
  const claims = remoteTicketClaimsSchema.parse(value);
  if (claims.protocolMinimum > claims.protocolMaximum) throw new Error("Invalid protocol range.");
  if (
    claims.protocolMinimum > REMOTE_TICKET_PROTOCOL_VERSION ||
    claims.protocolMaximum < REMOTE_TICKET_PROTOCOL_VERSION
  ) {
    throw new Error("Unsupported protocol range.");
  }
  if (claims.sessionExpiresAt <= Math.floor(now.getTime() / 1_000)) throw new Error("The remote session expired.");
  return claims;
}

function invalidJwksConfiguration(): never {
  throw new Error("Missing ticket JWKS configuration.");
}
