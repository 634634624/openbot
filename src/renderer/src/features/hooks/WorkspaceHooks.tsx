import { HooksPanel } from "@openbot/ui/features/hooks/HooksPanel";
import { useAgents } from "../agents/agents-context";
import { useServers } from "../servers/servers-context";
import { HooksProvider, useHooks } from "./hooks-context";
import { desktopHooksPort } from "./hooks-port";

export function WorkspaceHooks() {
  const { activeServer } = useServers();
  const { activeAgent, agentList } = useAgents();
  const local = () => activeServer()?.kind === "local";
  return (
    <HooksProvider port={local() ? desktopHooksPort : null} agentId={activeAgent()?.id ?? null}>
      <HooksWorkspaceContent supported={local()} agents={agentList()} />
    </HooksProvider>
  );
}

function HooksWorkspaceContent(props: { supported: boolean; agents: Array<{ id: string; name: string }> }) {
  const hooks = useHooks();
  return (
    <HooksPanel
      supported={props.supported}
      agents={props.agents}
      agentId={hooks.state.agentId}
      snapshot={hooks.state.snapshot}
      loading={hooks.state.loading}
      saving={hooks.state.saving}
      error={hooks.state.error}
      onScopeChange={hooks.setScope}
      onReload={() => void hooks.reload()}
      onSave={hooks.save}
      onCancelRun={hooks.cancelRun}
      onResetHistory={hooks.resetHistory}
    />
  );
}
