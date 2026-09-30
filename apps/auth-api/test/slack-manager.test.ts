import { createSlackWorkspaceKeyPair, openSlackWorkspaceGrant } from "@openbot/contracts/slack-workspace-grant";
import { describe, expect, it, vi } from "vitest";
import { SlackManagerService } from "../src/server/slack-manager";

const user = { id: "user-1", email: "a@example.com", name: null, avatarUrl: null };
const redirectUri = "https://openbot.run/v2/slack/manager/callback";

// The manager token can create and change Slack apps. The Worker must never return it in clear, and
// a callback whose state it did not sign must not reach Slack.
describe("Slack manager OAuth", () => {
  it("returns the manager token sealed to the host that started the sign-in", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        team: { id: "T1", name: "Acme" },
        authed_user: { id: "U1", access_token: "xoxp-manager-secret" },
      }),
    );
    const service = new SlackManagerService(
      { SLACK_MANAGER_CLIENT_ID: "client", SLACK_MANAGER_CLIENT_SECRET: "secret", SLACK_STATE_SECRET: "s".repeat(32) },
      { fetch },
    );
    const host = await createSlackWorkspaceKeyPair();
    const nonce = "nonce-0123456789abcdef";
    const state = new URL(
      await service.authorizeUrl(user, { hostNonce: nonce, hostPublicKey: host.publicKey, redirectUri }),
    ).searchParams.get("state");
    if (!state) throw new Error("The authorize URL has no state.");

    const [body, signature] = state.split(".");
    await expect(service.complete({ code: "code", state: `${body}x.${signature}`, redirectUri })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    const result = await service.complete({ code: "code", state, redirectUri });
    expect(JSON.stringify(result)).not.toContain("xoxp");
    expect(result.nonce).toBe(nonce);
    await expect(openSlackWorkspaceGrant(host.privateKey, nonce, result.grant)).resolves.toMatchObject({
      accessToken: "xoxp-manager-secret",
      workspaceId: "T1",
    });
  });
});
