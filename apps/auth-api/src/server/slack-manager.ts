// The OpenBot Slack manager app's OAuth. A workspace member lets it create and change Slack apps, so
// the desktop can give each agent its own app. The Worker exchanges the code because the client
// secret lives here, seals the resulting token to the host's key, and keeps nothing: no table, no
// log. The sealed grant goes back to the desktop in the URL fragment of `/slack/connect`.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { isRawP256PublicKey, sealSlackWorkspaceGrant } from "@openbot/contracts/slack-workspace-grant";
import { hmacSha256 } from "./crypto";
import type { AuthUser, WorkerBindings } from "./types";

// Only what `apps.manifest.*` needs. The manager app asks for no bot scope.
const MANAGER_USER_SCOPES = ["app_configurations:read", "app_configurations:write"];
const STATE_TTL_MS = 10 * 60_000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export class SlackManagerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface StatePayload {
  u: string;
  n: string;
  k: string;
  e: number;
}

export class SlackManagerService {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #stateSecret: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;

  constructor(
    bindings: Pick<WorkerBindings, "SLACK_MANAGER_CLIENT_ID" | "SLACK_MANAGER_CLIENT_SECRET" | "SLACK_STATE_SECRET">,
    options: { fetch?: Fetch; now?: () => number } = {},
  ) {
    const clientId = bindings.SLACK_MANAGER_CLIENT_ID?.trim();
    const clientSecret = bindings.SLACK_MANAGER_CLIENT_SECRET?.trim();
    const stateSecret = bindings.SLACK_STATE_SECRET?.trim();
    if (!clientId || !clientSecret || !stateSecret || new TextEncoder().encode(stateSecret).byteLength < 32) {
      throw new SlackManagerError(503, "slack_not_configured", "The Slack manager app is not configured.");
    }
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#stateSecret = stateSecret;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /** The Slack consent URL for one sign-in of one host. */
  async authorizeUrl(
    user: AuthUser,
    input: { hostNonce: string; hostPublicKey: string; redirectUri: string },
  ): Promise<string> {
    if (!NONCE_PATTERN.test(input.hostNonce) || !isRawP256PublicKey(input.hostPublicKey)) {
      throw new SlackManagerError(400, "invalid_slack_request", "The Slack sign-in request is invalid.");
    }
    const state = await this.#signState({
      u: user.id,
      n: input.hostNonce,
      k: input.hostPublicKey,
      e: this.#now() + STATE_TTL_MS,
    });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("scope", "");
    url.searchParams.set("user_scope", MANAGER_USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  /**
   * Exchanges the code and seals the token to the host key in `state`. Returns what the desktop
   * needs: the nonce, to find its sign-in, and the sealed grant.
   */
  async complete(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<{ nonce: string; grant: string }> {
    const state = await this.#verifyState(input.state);
    const response = await this.#fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.#clientId}:${this.#clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (!isDynamicRecord(body) || body.ok !== true) {
      throw new SlackManagerError(502, "slack_exchange_failed", "Slack did not accept the sign-in.");
    }
    if (body.is_enterprise_install === true) {
      throw new SlackManagerError(400, "slack_enterprise_install", "Connect one workspace, not a whole organization.");
    }
    const user = body.authed_user;
    const team = body.team;
    if (
      !isDynamicRecord(user) ||
      !isString(user.access_token) ||
      !isString(user.id) ||
      !isDynamicRecord(team) ||
      !isString(team.id)
    ) {
      throw new SlackManagerError(502, "slack_exchange_failed", "Slack did not accept the sign-in.");
    }
    return {
      nonce: state.n,
      grant: await sealSlackWorkspaceGrant(state.k, state.n, {
        accessToken: user.access_token,
        workspaceId: team.id,
        workspaceName: isString(team.name) ? team.name : team.id,
        userId: user.id,
      }),
    };
  }

  async #signState(payload: StatePayload): Promise<string> {
    const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    return `${body}.${await hmacSha256(this.#stateSecret, body)}`;
  }

  async #verifyState(state: string): Promise<StatePayload> {
    const [body, signature, extra] = state.split(".");
    if (!body || !signature || extra !== undefined) throw invalidState();
    let payload: unknown;
    try {
      // `verify` compares in constant time.
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.#stateSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (!(await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), new TextEncoder().encode(body)))) {
        throw invalidState();
      }
      payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    } catch {
      throw invalidState();
    }
    if (
      !isDynamicRecord(payload) ||
      !isString(payload.u) ||
      !isString(payload.n) ||
      !isString(payload.k) ||
      typeof payload.e !== "number" ||
      payload.e < this.#now()
    ) {
      throw invalidState();
    }
    return { u: payload.u, n: payload.n, k: payload.k, e: payload.e };
  }
}

function invalidState(): SlackManagerError {
  return new SlackManagerError(400, "slack_state_invalid", "The Slack sign-in expired. Start it again.");
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
