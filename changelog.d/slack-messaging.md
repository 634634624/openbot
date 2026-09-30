### Added

- Agents can answer in Slack. Open **Agent settings → Slack**, create a Slack app from the filled-in
  manifest, and paste its bot token and app-level token. People can then mention the agent in a
  channel it was invited to, reply in that thread, or send it a direct message. The agent answers in
  the same thread, can read and send files, and asks the person who wrote for approval with buttons.
  Reply `stop` to stop a request. The host connects to Slack itself, so no public address is needed,
  and a hosted server stays awake while it is connected. An owner or admin of a joined server can
  set it up from the desktop app or the browser client.
- OpenBot can also create the agent's Slack app for you. Connect a Slack workspace one time, then
  select **Add to** the workspace and allow the install. Each agent gets its own Slack app and bot
  user, renamed with the agent and deleted when you disconnect. Its events reach this computer through
  OpenBot's Signal service, which passes them on without storing them, so this needs an OpenBot account
  and a name for this computer.
