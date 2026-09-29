# Messaging connections

An agent can answer in an external chat platform. Slack is supported today. The design notes are in
[ARCHITECTURE.md](ARCHITECTURE.md#messaging-connections).

## Connect an agent to Slack

1. Open the agent, then **Agent settings → Slack**.
2. Select **Create Slack app**. Slack opens with a manifest that OpenBot filled in: the agent's name,
   the bot scopes, the events, interactivity and Socket Mode. Pick the workspace and create the app.
   **Copy manifest** gives the same manifest to paste by hand.
3. Install the app to the workspace. In **OAuth & Permissions**, copy the **Bot User OAuth Token**
   (`xoxb-`).
4. In **Basic Information → App-Level Tokens**, add a token with the `connections:write` scope and
   copy it (`xapp-`).
5. Paste both tokens and select **Connect**. The host checks the bot token with Slack before it
   stores anything.
6. In Slack, invite the agent to a channel with `/invite @name`, then mention it.

On a joined server, an owner or admin can do the same from their own computer or the browser client
at `/app`. The host must advertise `messaging-v1`.

## What the agent does in Slack

- A mention in a channel starts, or continues, a conversation in that thread. A reply in that thread
  reaches the agent without a mention.
- A direct message to the app always reaches the agent. All direct messages from one person are one
  conversation.
- Each conversation is its own OpenBot thread of the agent, so it does not mix with the agent's own
  chat. **Agent settings → Slack → Conversations** lists them and shows each one.
- The agent sees up to 30 earlier messages of the thread as context, and the files of the message.
- 👀 means the message arrived. "Working on it…" is replaced by the answer. ✅, ❌ or ⏹ shows the end.
- An approval appears in the thread with **Approve** and **Deny**. Only the person who wrote the
  message can answer it there. The OpenBot host can always answer it.
- `stop` or `cancel` in the thread, or the **Stop** button, stops the request of the person who
  sends it.

## Troubleshooting

| State | Cause | Action |
| --- | --- | --- |
| Token not accepted | Slack refused a token, or the app was uninstalled. | Disconnect, reinstall the app if needed, connect with new tokens. |
| Tokens do not match | The two tokens are from different Slack apps. | Disconnect, then use both tokens of one app. |
| Socket Mode is off | Socket Mode was turned off in the app settings. | Turn it on, then **Reconnect**. |
| Missing permissions | The app has fewer scopes than the manifest asks for. | Add them in **OAuth & Permissions**, reinstall the app, **Reconnect**. |
| Waiting for Slack | Slack rate-limited the app. | Nothing. The host tries again at the time shown. |
| Tokens unreadable | The host cannot decrypt the stored tokens. | Disconnect, then connect again. |
| Reconnecting | The host lost the connection. | Nothing, or **Reconnect** after the network is back. |

## Limits

- The host must run. Messages sent while it is offline, asleep or stopped are not answered later.
- An agent runs one turn at a time. A Slack request waits behind the agent's own work and behind
  channel work, and the thread shows that it waits. One agent keeps at most 5 Slack requests waiting,
  and one person at most 2.
- Use one Slack app per agent and per host. Two hosts with the same app token split Slack's events
  between them.
- Anyone who can post in the workspace, guests and Slack Connect members included, can give the
  agent work. The agent runs with the access you gave it. With Turbo or **Always allow**, it runs
  commands without asking.
- A hosted server stays awake while a Slack connection is live.
- A reply that the agent asks another OpenBot agent for arrives in the agent's own chat, not in
  Slack.
- A question the agent asks is answered on the host, not in Slack.

## Adding a platform

A platform is one `MessagingDriver` (`src/backend/messaging/messaging-types.ts`) and nothing in the
core changes:

- `validateCredentials` checks the form of what the user pastes.
- `createAdapter` implements `MessagingAdapter`: post, edit, react, upload, download, history,
  author and place names, and mentions.
- `createTransport` implements `MessagingTransport` and turns the platform's events into
  `InboundMessage` and `InboundAction` values. It must connect out from the host.

| Platform | Transport | Conversation key | Notes |
| --- | --- | --- | --- |
| Slack | Socket Mode WebSocket | `thread_ts`, or `direct` for a DM | Implemented. |
| Discord | Gateway WebSocket (`@discordjs/ws` style: heartbeat, resume) | The thread channel id, or the message id that starts a thread | Needs the Message Content intent. Reactions map directly. |
| Telegram | Long polling with `getUpdates` and an offset | `message_thread_id` in a forum, else the chat id | No history API: store what the bot sees for context. |

Then add the platform to `MESSAGING_PLATFORMS` and to the `messaging-v1` codec (a new capability,
because the codec is frozen), a setup view in the renderer, and its i18n keys. The database needs no
migration: `platform` has no `CHECK`.
