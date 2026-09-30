### Added

- Agents can answer in Slack. Open **Agent settings → Slack**, select **Connect Slack** one time and
  pick your workspace, then select **Add to Slack** for each agent and allow the install. Each agent
  gets its own Slack app and bot user, renamed with the agent and deleted when you disconnect. People
  can mention the agent in a channel it was invited to, reply in that thread, or send it a direct
  message. The agent answers in the same thread, can read and send files, and asks the person who
  wrote for approval with buttons. Reply `stop` to stop a request. Slack's events reach this computer
  through OpenBot's Signal service, which passes them on without storing them, so this needs an
  OpenBot account and a name for this computer. A hosted server stays awake while Slack is connected.
  An owner or admin of a joined server can see and manage the connection from the desktop app or the
  browser client.
