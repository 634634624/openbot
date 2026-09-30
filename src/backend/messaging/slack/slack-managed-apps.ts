import { createHash, randomBytes } from "node:crypto";
import type { SlackWorkspace } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createSlackWorkspaceKeyPair, openSlackWorkspaceGrant } from "@openbot/contracts/slack-workspace-grant";
import { sourceText } from "@openbot/i18n/source";
import type { MessagingCredentials } from "../messaging-service";
import type { MessagingStore } from "../messaging-store";
import type { IngressAnswer, IngressDelivery, MessagingIngress } from "../messaging-types";
import { SLACK_BOT_SCOPES, slackManifest } from "./slack-manifest";
import { SlackApiError, SlackWebApi } from "./slack-web-api";

export const SLACK_WORKSPACE_KEY_PREFIX = "slack-workspace:";

/** How long a sign-in or an install link stays usable. */
const PENDING_TTL_MS = 15 * 60_000;
/** How long the host waits for the ingress socket before it creates an app. */
const INGRESS_WAIT_MS = 15_000;
/** Slack checks the request URL while it creates or changes an app. */
const URL_CHECK_WINDOW_MS = 2 * 60_000;

/** The account service half of the manager app: the Worker holds its client secret. */
export interface SlackManagerPort {
  /** The Slack consent URL for one sign-in, which seals its token to `hostPublicKey`. */
  authorize(input: { hostNonce: string; hostPublicKey: string }): Promise<string>;
  /** The HTTPS page that sends an install's code back to `openbot://slack-install`. */
  installRedirectUrl(): string;
  openExternal(url: string): Promise<void>;
}

/** What the managed apps need from the connection lifecycle that `MessagingService` owns. */
export interface ManagedConnections {
  restart(connectionId: string): Promise<void>;
  stop(connectionId: string): Promise<void>;
}

export interface SlackManagedAppsOptions {
  store: MessagingStore;
  credentials: MessagingCredentials;
  ingress: MessagingIngress;
  manager: SlackManagerPort;
  connections: ManagedConnections;
  /** Only tests change this. */
  origin?: string;
}

interface CreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

interface ManagedCredentials {
  botToken?: string;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  requestUrl: string;
  workspaceId: string;
  manifestHash: string;
}

/**
 * Owns the Slack apps that OpenBot creates for agents through its manager app: the workspace
 * sign-in, the app of each agent, its install, and keeping its name and description in step with
 * the agent. A workspace's manager token and each app's secrets live only in `MessagingCredentials`.
 * It never imports the database facade.
 */
export class SlackManagedApps {
  readonly #options: SlackManagedAppsOptions;
  /** One-use key pairs of the workspace sign-ins that are open, by nonce. */
  readonly #signIns = new Map<string, { privateKey: CryptoKey; expiresAt: number }>();
  /** The install links that are open, by OAuth state. */
  readonly #installs = new Map<string, { connectionId: string; expiresAt: number }>();
  /** Connections whose app Slack is creating or changing now, with the time the window ends. */
  readonly #urlChecks = new Map<string, number>();

  constructor(options: SlackManagedAppsOptions) {
    this.#options = options;
  }

  static isManaged(credentials: Record<string, string> | null): boolean {
    return credentials?.signingSecret !== undefined;
  }

  workspaces(): SlackWorkspace[] {
    return this.workspaceKeys().flatMap((key) => {
      const values = this.#options.credentials.get(key);
      return values?.workspaceId && values.workspaceName
        ? [{ workspaceId: values.workspaceId, name: values.workspaceName }]
        : [];
    });
  }

  workspaceKeys(): string[] {
    return this.#options.credentials.keys().filter((key) => key.startsWith(SLACK_WORKSPACE_KEY_PREFIX));
  }

  /** Opens the manager app's consent in the browser. The deep link to `completeWorkspace` ends it. */
  async startWorkspace(): Promise<void> {
    this.#prune();
    const nonce = randomBytes(24).toString("base64url");
    const { privateKey, publicKey } = await createSlackWorkspaceKeyPair();
    this.#signIns.set(nonce, { privateKey, expiresAt: Date.now() + PENDING_TTL_MS });
    const url = await this.#options.manager.authorize({ hostNonce: nonce, hostPublicKey: publicKey });
    await this.#options.manager.openExternal(url);
  }

  /** False for a nonce this run did not start: such a link does nothing. */
  async completeWorkspace(nonce: string, grant: string): Promise<boolean> {
    this.#prune();
    const signIn = this.#signIns.get(nonce);
    if (!signIn) return false;
    this.#signIns.delete(nonce);
    const opened = await openSlackWorkspaceGrant(signIn.privateKey, nonce, grant);
    await this.#options.credentials.set(`${SLACK_WORKSPACE_KEY_PREFIX}${opened.workspaceId}`, {
      accessToken: opened.accessToken,
      workspaceId: opened.workspaceId,
      workspaceName: opened.workspaceName,
      userId: opened.userId,
    });
    return true;
  }

  /** Forgets the manager token and asks Slack to revoke it. The agents' apps keep working. */
  async disconnectWorkspace(workspaceId: string): Promise<void> {
    const key = `${SLACK_WORKSPACE_KEY_PREFIX}${workspaceId}`;
    const token = this.#options.credentials.get(key)?.accessToken;
    await this.#options.credentials.clear(key);
    if (token)
      await this.#api(token)
        .call("auth.revoke")
        .catch(() => undefined);
  }

  /**
   * Creates the agent's Slack app in the workspace and opens its install page. Slack checks the
   * request URL while it creates the app, before the host knows the app's signing secret, so the
   * ingress socket must be online first and the check is answered for this connection only.
   */
  async createApp(
    connectionId: string,
    agent: { name: string; description: string },
    workspaceId: string,
  ): Promise<void> {
    const token = this.#managerToken(workspaceId);
    const release = this.#options.ingress.acquire();
    try {
      await this.#waitForIngress();
      const requestUrl = await this.#options.ingress.requestUrl(connectionId);
      const manifest = slackManifest(agent, {
        requestUrl,
        redirectUrl: this.#options.manager.installRedirectUrl(),
      });
      await this.#options.connections.stop(connectionId);
      const previous = this.#managed(connectionId);
      if (previous) await this.#deleteApp(connectionId, previous).catch(() => undefined);
      this.#urlChecks.set(connectionId, Date.now() + URL_CHECK_WINDOW_MS);
      let created: CreatedApp;
      try {
        created = await this.#createManifest(token, manifest);
      } finally {
        this.#urlChecks.delete(connectionId);
      }
      await this.#options.credentials.set(connectionId, {
        signingSecret: created.signingSecret,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        requestUrl,
        workspaceId,
        manifestHash: manifestHash(manifest),
      } satisfies ManagedCredentials);
      this.#options.store.updateConnection(connectionId, {
        enabled: true,
        appId: created.appId,
        workspaceId,
        workspaceName: this.workspaces().find((workspace) => workspace.workspaceId === workspaceId)?.name ?? null,
        botUserId: null,
        lastErrorCode: null,
      });
      await this.openInstall(connectionId);
    } finally {
      release();
    }
  }

  /** Opens the install page of the connection's app again, with a new state. */
  async openInstall(connectionId: string): Promise<void> {
    const managed = this.#managed(connectionId);
    const record = this.#options.store.connection(connectionId);
    if (!managed || !record?.appId) throw new Error(sourceText("error.messaging.notConnected"));
    this.#prune();
    const state = randomBytes(24).toString("base64url");
    this.#installs.set(state, { connectionId, expiresAt: Date.now() + PENDING_TTL_MS });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", managed.clientId);
    url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    url.searchParams.set("redirect_uri", this.#options.manager.installRedirectUrl());
    url.searchParams.set("state", state);
    await this.#options.manager.openExternal(url.toString());
  }

  /** False for a state this run did not start. Throws when Slack refuses the code. */
  async completeInstall(state: string, code: string): Promise<boolean> {
    this.#prune();
    const install = this.#installs.get(state);
    if (!install) return false;
    this.#installs.delete(state);
    const managed = this.#managed(install.connectionId);
    const record = this.#options.store.connection(install.connectionId);
    if (!managed || !record?.appId) return false;
    const response = await this.#api("").call("oauth.v2.access", {
      client_id: managed.clientId,
      client_secret: managed.clientSecret,
      code,
      redirect_uri: this.#options.manager.installRedirectUrl(),
    });
    const team = isDynamicRecord(response.team) ? response.team : {};
    if (
      !isString(response.access_token) ||
      response.token_type !== "bot" ||
      response.app_id !== record.appId ||
      team.id !== managed.workspaceId
    )
      throw new Error(sourceText("error.messaging.slackInstallFailed"));
    await this.#options.credentials.set(install.connectionId, { ...managed, botToken: response.access_token });
    await this.#options.connections.restart(install.connectionId);
    return true;
  }

  /**
   * The answer to Slack's URL check for an app it is creating now, which the host cannot verify:
   * it does not have the signing secret yet. The answer only echoes the challenge, so it proves
   * nothing to anyone else. Null when the connection is not in that window.
   */
  answerUrlCheck(connectionId: string, delivery: IngressDelivery): IngressAnswer | null {
    const until = this.#urlChecks.get(connectionId);
    if (!until || until < Date.now() || delivery.kind !== "events") return null;
    try {
      const body = JSON.parse(new TextDecoder().decode(delivery.body));
      if (isDynamicRecord(body) && body.type === "url_verification" && isString(body.challenge))
        return { status: 200, contentType: "text/plain", body: body.challenge };
    } catch {
      // Not a URL check: the connection's transport answers it.
    }
    return null;
  }

  /** Brings each managed app's name and description in step with its agent. */
  async sync(agents: ReadonlyMap<string, { name: string; description: string }>): Promise<void> {
    for (const record of this.#options.store.connections()) {
      const managed = this.#managed(record.connectionId);
      const agent = agents.get(record.agentId);
      if (!managed || !agent || !record.appId) continue;
      const manifest = slackManifest(agent, {
        requestUrl: managed.requestUrl,
        redirectUrl: this.#options.manager.installRedirectUrl(),
      });
      const hash = manifestHash(manifest);
      if (hash === managed.manifestHash) continue;
      const token = this.#optionalManagerToken(managed.workspaceId);
      if (!token) continue;
      this.#urlChecks.set(record.connectionId, Date.now() + URL_CHECK_WINDOW_MS);
      try {
        await this.#api(token).call("apps.manifest.update", { app_id: record.appId, manifest });
        await this.#options.credentials.set(record.connectionId, { ...managed, manifestHash: hash });
      } finally {
        this.#urlChecks.delete(record.connectionId);
      }
    }
  }

  /**
   * Deletes the connection's Slack app, when the host still has the workspace's manager token.
   * `appId` is for a connection whose row is already gone with its agent.
   */
  async deleteApp(connectionId: string, appId?: string | null): Promise<void> {
    const managed = this.#managed(connectionId);
    if (managed) await this.#deleteApp(connectionId, managed, appId);
  }

  /** `apps.manifest.create`, with Slack's refusals as errors that a user can act on. */
  async #createManifest(token: string, manifest: ReturnType<typeof slackManifest>): Promise<CreatedApp> {
    let response: Awaited<ReturnType<SlackWebApi["call"]>>;
    try {
      response = await this.#api(token).call("apps.manifest.create", { manifest });
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "managed_app_limit_reached")
        throw new Error(sourceText("error.messaging.slackAppLimit"));
      if (error instanceof SlackApiError) throw new Error(sourceText("error.messaging.slackAppRefused"));
      throw error;
    }
    const credentials = isDynamicRecord(response.credentials) ? response.credentials : {};
    if (
      !isString(response.app_id) ||
      !isString(credentials.client_id) ||
      !isString(credentials.client_secret) ||
      !isString(credentials.signing_secret)
    )
      throw new Error(sourceText("error.messaging.slackAppRefused"));
    return {
      appId: response.app_id,
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      signingSecret: credentials.signing_secret,
    };
  }

  async #deleteApp(connectionId: string, managed: ManagedCredentials, knownAppId?: string | null): Promise<void> {
    const appId = knownAppId ?? this.#options.store.connection(connectionId)?.appId;
    const token = this.#optionalManagerToken(managed.workspaceId);
    if (!appId || !token) return;
    try {
      await this.#api(token).call("apps.manifest.delete", { app_id: appId });
    } catch (error) {
      // The user may have deleted the app in Slack already.
      if (!(error instanceof SlackApiError && error.code === "app_not_found")) throw error;
    }
  }

  async #waitForIngress(): Promise<void> {
    const ingress = this.#options.ingress;
    if (ingress.state() === "online") return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(sourceText("error.messaging.relayUnavailable")));
      }, INGRESS_WAIT_MS);
      const unsubscribe = ingress.onState((state) => {
        if (state === "connecting") return;
        clearTimeout(timer);
        unsubscribe();
        if (state === "online") resolve();
        else reject(new Error(sourceText("error.messaging.relayUnavailable")));
      });
    });
  }

  #managed(connectionId: string): ManagedCredentials | null {
    const values = this.#options.credentials.get(connectionId);
    if (!values?.signingSecret || !values.clientId || !values.clientSecret || !values.requestUrl || !values.workspaceId)
      return null;
    return {
      ...(values.botToken ? { botToken: values.botToken } : {}),
      signingSecret: values.signingSecret,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      requestUrl: values.requestUrl,
      workspaceId: values.workspaceId,
      manifestHash: values.manifestHash ?? "",
    };
  }

  #managerToken(workspaceId: string): string {
    const token = this.#optionalManagerToken(workspaceId);
    if (!token) throw new Error(sourceText("error.messaging.workspaceNotConnected"));
    return token;
  }

  #optionalManagerToken(workspaceId: string): string | null {
    return this.#options.credentials.get(`${SLACK_WORKSPACE_KEY_PREFIX}${workspaceId}`)?.accessToken ?? null;
  }

  #api(token: string): SlackWebApi {
    return new SlackWebApi({ token, origin: this.#options.origin });
  }

  #prune(): void {
    const now = Date.now();
    for (const [nonce, signIn] of this.#signIns) if (signIn.expiresAt < now) this.#signIns.delete(nonce);
    for (const [state, install] of this.#installs) if (install.expiresAt < now) this.#installs.delete(state);
  }
}

function manifestHash(manifest: ReturnType<typeof slackManifest>): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
