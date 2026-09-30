// `bun run dev:slack`: the dev stack, reachable by Slack. Slack posts an agent app's events to
// Signal and sends the browser back after an install, and it accepts only public HTTPS addresses. So
// this opens a `cloudflared` quick tunnel to Signal and one to the dev app's own sign-in listener
// (`src/main/slack-dev-callback-server.ts`), and gives the stack the tunnel addresses. The install
// then reaches the dev app directly, not an installed OpenBot that owns `openbot://`. The tunnels
// live as long as this process.
//
// `.env.slack-dev` in the worktree root holds the Slack values. Git ignores it. Until Slack enrolls
// the OpenBot manager app, an App Configuration Token stands in for the workspace's manager token:
//
//   OPENBOT_DEV_SLACK_CONFIG_TOKEN='xoxe.xoxp-…'   (12 hours; api.slack.com/apps)
//   OPENBOT_DEV_SLACK_WORKSPACE_ID='T…'
//   OPENBOT_DEV_SLACK_WORKSPACE_NAME='…'
//
// The route token key is `SLACK_ROUTE_PRIVATE_JWK` and `SLACK_ROUTE_KEY_ID` in
// `apps/auth-api/.env.dev`. In development it can be a copy of the ticket key.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("dev-slack");

const SLACK_FILE = ".env.slack-dev";
const SLACK_KEYS = [
  "OPENBOT_DEV_SLACK_CONFIG_TOKEN",
  "OPENBOT_DEV_SLACK_WORKSPACE_ID",
  "OPENBOT_DEV_SLACK_WORKSPACE_NAME",
] as const;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;
const TUNNEL_TIMEOUT_MS = 45_000;

interface TunnelledSpec {
  name: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Reads the Slack values: `KEY=value` or `export KEY='value'` lines, and only the keys above. A
 * value set in the shell wins over the file.
 */
export function readSlackDevelopmentValues(text: string, environment: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    const key = match?.[1];
    if (!key || !SLACK_KEYS.some((allowed) => allowed === key)) continue;
    values[key] = (match[2] ?? "").replace(/^(['"])(.*)\1$/u, "$2");
  }
  for (const key of SLACK_KEYS) {
    const fromShell = environment[key];
    if (fromShell) values[key] = fromShell;
  }
  return values;
}

/**
 * Opens the two tunnels and points every service of the stack at them. Returns the function that
 * closes them. Stops the start when a tunnel or a Slack value is missing: a stack that Slack cannot
 * reach would look like a bug in the app.
 */
export async function attachSlackTunnels(specs: TunnelledSpec[], projectRoot: string): Promise<() => void> {
  const file = join(projectRoot, SLACK_FILE);
  const values = readSlackDevelopmentValues(existsSync(file) ? readFileSync(file, "utf8") : "", process.env);
  if (!values.OPENBOT_DEV_SLACK_CONFIG_TOKEN || !values.OPENBOT_DEV_SLACK_WORKSPACE_ID) {
    throw new Error(
      `--slack needs OPENBOT_DEV_SLACK_CONFIG_TOKEN and OPENBOT_DEV_SLACK_WORKSPACE_ID in ${SLACK_FILE} or the shell.`,
    );
  }
  const signalPort = specs.find((spec) => spec.name === "remote")?.env.REMOTE_SIGNAL_PORT;
  if (!signalPort || !specs.some((spec) => spec.name === "app"))
    throw new Error("--slack needs Signal and the app: use the app or all target.");
  const callbackPort = String(await freePort());

  const tunnels: ChildProcess[] = [];
  const close = () => {
    for (const tunnel of tunnels) if (tunnel.exitCode === null) tunnel.kill("SIGTERM");
  };
  process.once("exit", close);
  try {
    const [signalUrl, callbackUrl] = await Promise.all([
      openTunnel(signalPort, tunnels),
      openTunnel(callbackPort, tunnels),
    ]);
    const tunnelled = {
      ...values,
      REMOTE_SIGNAL_URL: `${signalUrl.replace("https://", "wss://")}/v1/signal`,
      OPENBOT_DEV_SLACK_CALLBACK_PORT: callbackPort,
      OPENBOT_DEV_SLACK_REDIRECT_URL: `${callbackUrl}/slack-install`,
    };
    for (const spec of specs) Object.assign(spec.env, tunnelled);
    logger.info(`Slack reaches Signal at ${signalUrl} and the dev app's sign-in listener at ${callbackUrl}.`);
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

/** A loopback port that nothing listens on now. The dev app binds it when it starts. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No free port for the Slack sign-in listener."))));
    });
  });
}

function openTunnel(port: string, tunnels: ChildProcess[]): Promise<string> {
  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  tunnels.push(tunnel);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => fail(new Error(`cloudflared did not open a tunnel to port ${port}.`)),
      TUNNEL_TIMEOUT_MS,
    );
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_192);
      const url = TUNNEL_URL.exec(output)?.[0];
      if (!url) return;
      clearTimeout(timer);
      tunnel.stdout?.off("data", read);
      tunnel.stderr?.off("data", read);
      // Keep draining, so a full pipe never stops the tunnel.
      tunnel.stdout?.resume();
      tunnel.stderr?.resume();
      resolve(url);
    };
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    tunnel.stdout?.on("data", read);
    tunnel.stderr?.on("data", read);
    tunnel.once("error", () =>
      fail(new Error("cloudflared is not installed. Install it with `brew install cloudflared`.")),
    );
    tunnel.once("exit", (code) => fail(new Error(`cloudflared stopped with code ${code ?? "unknown"}.`)));
  });
}
