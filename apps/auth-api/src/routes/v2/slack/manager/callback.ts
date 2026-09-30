import { createFileRoute } from "@tanstack/solid-router";
import { requestSlackManager } from "../../../../server/request-auth";
import { SlackManagerError } from "../../../../server/slack-manager";

// Slack returns here after the manager app's consent. The sealed grant goes to `/slack/connect` in
// the URL fragment, which the browser does not send to any server, and that page opens OpenBot.
export const Route = createFileRoute("/v2/slack/manager/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const target = new URL("/slack/connect", url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          target.hash = new URLSearchParams({ error: url.searchParams.get("error") ?? "slack_cancelled" }).toString();
          return redirect(target);
        }
        try {
          const result = await requestSlackManager().complete({
            code,
            state,
            redirectUri: new URL("/v2/slack/manager/callback", url).toString(),
          });
          target.hash = new URLSearchParams({ nonce: result.nonce, grant: result.grant }).toString();
        } catch (error) {
          target.hash = new URLSearchParams({
            error: error instanceof SlackManagerError ? error.code : "slack_exchange_failed",
          }).toString();
        }
        return redirect(target);
      },
    },
  },
});

function redirect(target: URL): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
