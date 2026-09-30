# OpenBot Slack manager app: requirements

The manager app is the one Slack app that OpenBot owns. A workspace member connects it one time.
Then the desktop host uses its token to create one Slack app for each agent (`apps.manifest.create`).
Each agent app is a separate bot user, so people can mention it and send it direct messages.

The code that uses this app is on branch `slack-messaging`. See [messaging.md](messaging.md) and
[ARCHITECTURE.md](ARCHITECTURE.md#messaging-connections).

## 1. Slack approval (blocks the start)

- [ ] Slack must enroll the app as a **manager app**. There is no self-serve switch.
      `apps.manifest.create` returns `invalid_manager_app` until the app's home team has
      "manager app support" enabled. Contact Slack developer relations or partner support.
- [ ] Get from Slack, in writing:
  - the limit of managed apps per manager app (`managed_app_limit_reached`);
  - whether the user token from the manager OAuth expires or rotates;
  - whether `apps.icon.set` works with the manager user token;
  - whether `apps.manifest.create` checks the request URL before it returns. The host answers the
    URL check for 2 minutes during create and update.

## 2. App settings in Slack

| Setting | Value |
| --- | --- |
| Name | `OpenBot` |
| Home workspace | An OpenBot-owned workspace (the "home team" that Slack enrolls) |
| Bot user | None. The manager app needs no bot. |
| Bot scopes | None |
| User scopes | `app_configurations:read`, `app_configurations:write` |
| Redirect URL | `https://api.openbot.run/v2/slack/manager/callback` |
| Public distribution | On. Other workspaces must be able to install it through OAuth. |
| Token rotation | Off |
| Socket Mode | Off |
| Event subscriptions | None |
| Interactivity | Off |
| Org-wide deploy (Enterprise Grid) | Off. The callback refuses an organization install. |

Manifest, for reference:

```json
{
  "display_information": {
    "name": "OpenBot",
    "description": "Creates one Slack app for each of your OpenBot agents."
  },
  "oauth_config": {
    "redirect_urls": ["https://api.openbot.run/v2/slack/manager/callback"],
    "scopes": { "user": ["app_configurations:read", "app_configurations:write"] }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Also:

- [ ] App icon and short description for the consent page.
- [ ] Privacy policy URL and support URL, if Slack asks for them for public distribution.
- [ ] Do not list the app in the Slack Marketplace. Marketplace review is not necessary for the
      OAuth install to work.

## 3. Account service (Cloudflare Worker, `apps/auth-api`)

Secrets and variables. None of them is in `secrets.required` in `wrangler.jsonc`: without them the
Slack routes answer `503 slack_not_configured`, and nothing else changes.

| Name | Kind | Value |
| --- | --- | --- |
| `SLACK_MANAGER_CLIENT_ID` | variable | The manager app's client ID |
| `SLACK_MANAGER_CLIENT_SECRET` | secret | The manager app's client secret |
| `SLACK_STATE_SECRET` | secret | Random, at least 32 bytes. Signs the OAuth `state`. |
| `SLACK_ROUTE_PRIVATE_JWK` | secret | A new ES256 (P-256) private JWK. Signs the Slack route tokens. |
| `SLACK_ROUTE_KEY_ID` | variable | The `kid` of that key, for example `openbot-slack-route-1` |
| `REMOTE_TICKET_PUBLIC_JWKS` | secret (update) | Add the route key's **public** JWK beside the ticket key |

Make the route key, for example:

```sh
bun -e 'import { exportJWK, generateKeyPair } from "jose";
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const kid = "openbot-slack-route-1";
console.log(JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: "ES256" }));
console.log(JSON.stringify({ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }));'
```

Keep the route key separate from the ticket key. The route token has no expiry and is in the request
URL of every agent app, so rotating it means updating every app's manifest.

Routes that this uses:

- `POST /v2/slack/manager/authorize` (signed-in account) returns the Slack consent URL.
- `GET /v2/slack/manager/callback` exchanges the code and sends the sealed token to `/slack/connect`.
- `GET /slack/connect` opens `openbot://slack-workspace` or `openbot://slack-install`.
- `POST /v2/remote/hosts/:hostId/slack-route` (host machine token) returns the request URL.

- [ ] Check that `https://api.openbot.run/slack/connect` serves the page. The desktop uses
      `resolveApiUrl("/slack/connect")` as each agent app's install redirect.

## 4. Signal (`remote/`)

- [ ] Deploy Signal **before** any desktop build that uses managed apps. An old Signal closes a socket
      that sends a frame type it does not know.
- [ ] Deploy the new `remote/nginx/signal.openbot.run.conf`. The `location /v1/slack/` block turns off
      the access log (the path holds the route token), caps the body at 64 KB, and sets 5 s timeouts.
- [ ] If Signal loads keys from `REMOTE_TICKET_PUBLIC_KEYS` and not from the Worker's JWKS URL, add
      the route public key there too.

## 5. What each agent app gets

The host makes these; nothing is manual. For reference:

- Bot scopes: `app_mentions:read`, `channels:history`, `channels:join`, `channels:read`, `chat:write`, `files:read`,
  `files:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`,
  `mpim:history`, `reactions:write`, `users:read`.
- Bot events: `app_mention`, `channel_created`, `message.channels`, `message.groups`, `message.im`,
  `message.mpim`, plus `app_uninstalled` and `tokens_revoked`.
- The icon: the agent's avatar, set with `apps.icon.set` and the manager token. Slack allows this
  only for an app that the manager app created, so an app made with a development configuration
  token keeps the default icon.
- Request URL for events and interactivity: `https://signal.openbot.run/v1/slack/events/<route token>`.
- Redirect URL: `https://api.openbot.run/slack/connect`.
- Messages tab on, users can send messages. Socket Mode off. Token rotation off.

## 6. Limits the product must show

- A free Slack workspace allows at most 10 apps, and each agent uses one app.
- A workspace can require admin approval for new apps. The agent then stays "Waiting for install".
- Slack retries an event at about 0, 1 and 5 minutes when the host does not answer, then drops it.
- Slack turns off event delivery for an app only when more than 95% of deliveries fail in 60 minutes
  and the app gets 1,000 or more events an hour.

## 7. Development and test

- Slack accepts only HTTPS redirect URLs. `localhost` works only with PKCE, and a PKCE desktop
  redirect cannot request the scopes the manager app needs. Use the test Worker
  (`bun run deploy:test`) or an HTTPS tunnel for local work.
- Use a second manager app for development, with its own redirect URL, so production keys stay
  apart.

## 8. Acceptance checklist

- [ ] Slack enrolled the manager app, and `apps.manifest.create` works with its user token.
- [ ] Worker secrets and the JWKS are set in test, then in production.
- [ ] Signal and Nginx are deployed.
- [ ] In a test workspace: connect the workspace, add two agents, allow both installs.
- [ ] Mention each agent in a channel and send each a direct message. Each answer comes from the
      correct bot user.
- [ ] Rename an agent: its Slack app name changes.
- [ ] Disconnect an agent: its Slack app is deleted.
- [ ] Stop OpenBot, send a message, start OpenBot within 5 minutes: the message is answered.
- [ ] Nginx and Signal logs show no route token and no message text.
