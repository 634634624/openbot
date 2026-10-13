import { HookRunItem } from "@openbot/ui/features/hooks/HookRunItem";
import { HooksPanel } from "@openbot/ui/features/hooks/HooksPanel";
import { createStore } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { HOOK_FIXTURE_AGENTS, HOOK_FIXTURE_RUN, HOOK_FIXTURE_SNAPSHOT } from "../src/features/hooks/hooks-fixtures";

const meta = {
  title: "Hooks",
  component: HooksPanel,
  args: {
    supported: true,
    snapshot: HOOK_FIXTURE_SNAPSHOT,
    loading: false,
    saving: false,
    error: null,
    agents: HOOK_FIXTURE_AGENTS,
    agentId: null,
    onScopeChange: fn(),
    onReload: fn(),
    onSave: fn(async () => true),
    onCancelRun: fn(),
    onResetHistory: fn(async () => true),
  },
  render: (args) => {
    const [state, setState] = createStore({ snapshot: structuredClone(args.snapshot), agentId: args.agentId });
    return (
      <HooksPanel
        {...args}
        snapshot={state.snapshot}
        agentId={state.agentId}
        onScopeChange={(agentId) =>
          setState((value) => {
            value.agentId = agentId;
          })
        }
        onSave={async (settings, expectedRevision) => {
          if (!state.snapshot || (expectedRevision !== undefined && expectedRevision !== state.snapshot.revision))
            return false;
          setState((value) => {
            if (value.snapshot) {
              value.snapshot.settings = structuredClone(settings);
              value.snapshot.revision++;
            }
          });
          return true;
        }}
        onCancelRun={(runId) =>
          setState((value) => {
            if (value.snapshot)
              value.snapshot.runs = value.snapshot.runs.map((run) =>
                run.id === runId && (run.status === "running" || run.status === "queued")
                  ? { ...run, status: "interrupted", finishedAt: "2026-10-13T10:00:01.000Z" }
                  : run,
              );
          })
        }
        onResetHistory={async (expectedRevision) => {
          if (
            !state.snapshot ||
            state.snapshot.revision !== expectedRevision ||
            state.snapshot.settings.enabled ||
            state.snapshot.runs.some((run) => run.status === "queued" || run.status === "running")
          )
            return false;
          setState((value) => {
            if (value.snapshot) {
              value.snapshot.runs = [];
              value.snapshot.blockedReason = null;
              value.snapshot.revision++;
            }
          });
          return true;
        }}
      />
    );
  },
} satisfies Meta<typeof HooksPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Global: Story = {};
export const Agent: Story = { args: { agentId: "fixture-agent" } };
export const RemoteUnsupported: Story = { args: { supported: false, snapshot: null } };
export const CorruptConfiguration: Story = {
  args: { snapshot: { ...HOOK_FIXTURE_SNAPSHOT, blockedReason: "corrupt" } },
};
export const ChatFiringRunning: Story = { render: () => <HookRunItem run={HOOK_FIXTURE_RUN} /> };
export const ChatFiringCompleted: Story = {
  render: () => <HookRunItem run={HOOK_FIXTURE_SNAPSHOT.runs[2] ?? HOOK_FIXTURE_RUN} />,
};
