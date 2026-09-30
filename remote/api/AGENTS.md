# `remote/api`

The Remote API is the Signal service. It verifies remote tickets, issues resume tokens and TURN
credentials, and relays WebRTC signalling between peers. It does not carry team chats, files, or
commands. The one exception is `POST /v1/slack/events/:route`: it passes a managed Slack app's
request body to the host's `ingress` socket in transit. Do not store, log, or inspect that body, and
do not verify its Slack signature here: only the host has the signing secret.

- The message shapes come from `@openbot/contracts/signal-protocol`. `src/protocol.ts` only
  re-exports them for the server. Change them there, and keep released messages compatible.
- `src/tokens.ts` holds the secrets. Compare secrets in constant time (`timingSafeEqual`), and keep
  the TTL limits. Never log a ticket, a token, a Slack route token or request path, a TURN credential, or a secret from
  `src/config.ts`. Log only the error
  message, as `src/app.ts` does.
- This project uses Bun types. Keep them inside `remote/api`; root `scripts/**` and Electron main
  use Node types. See [check design notes](../../docs/development-checks.md#check-coverage).
- `remote/scripts/update.ts` recreates the live coturn container. Do not run it as a check.

Run one test file: `bun run --cwd remote/api test -- test/<name>.test.ts`.
