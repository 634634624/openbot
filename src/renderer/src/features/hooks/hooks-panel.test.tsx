import type { HookRun } from "@openbot/contracts/ipc-hooks";
import { HooksPanel, type HooksPanelProps } from "@openbot/ui/features/hooks/HooksPanel";
import { HookRunItem } from "@openbot/ui/features/hooks/HookRunItem";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createStore } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { HOOK_FIXTURE_AGENTS, HOOK_FIXTURE_RUN, HOOK_FIXTURE_SNAPSHOT } from "./hooks-fixtures";

function panelProps(overrides: Partial<HooksPanelProps> = {}): HooksPanelProps {
  return {
    supported: true,
    snapshot: structuredClone(HOOK_FIXTURE_SNAPSHOT),
    loading: false,
    saving: false,
    error: null,
    agents: HOOK_FIXTURE_AGENTS,
    agentId: null,
    onScopeChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(async () => true),
    onCancelRun: vi.fn(),
    onResetHistory: vi.fn(async () => true),
    ...overrides,
  };
}

describe("HooksPanel", () => {
  it("keeps remote configuration unavailable", () => {
    const props = panelProps({ supported: false, snapshot: null });
    render(() => <HooksPanel {...props} />);

    expect(screen.getByRole("status")).toHaveTextContent("only on this computer");
    expect(screen.queryByRole("button", { name: "Create hook" })).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("creates disabled configuration without starting a command", async () => {
    const props = panelProps();
    render(() => <HooksPanel {...props} />);
    await fireEvent.click(screen.getByRole("button", { name: "Create hook" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Audit" } });
    await fireEvent.input(screen.getByRole("textbox", { name: "Command" }), { target: { value: "fixture command" } });
    expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
    await fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        definitions: expect.arrayContaining([
          expect.objectContaining({ name: "Audit", enabled: false, command: "fixture command" }),
        ]),
      }),
      HOOK_FIXTURE_SNAPSHOT.revision,
    ));
    expect(props.onCancelRun).not.toHaveBeenCalled();
  });

  it("changes an agent override while preserving the enabled global definition", async () => {
    const snapshot = structuredClone(HOOK_FIXTURE_SNAPSHOT);
    snapshot.settings.agentOverrides = {};
    const props = panelProps({ snapshot, agentId: "fixture-agent" });
    render(() => <HooksPanel {...props} />);
    await fireEvent.click(screen.getByRole("switch", { name: "Enable Workspace audit for this agent" }));

    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      definitions: snapshot.settings.definitions,
      agentOverrides: { "fixture-agent": { "fixture-global-hook": false } },
    }));
  });

  it("retains a stale draft and refuses to overwrite a newer revision", async () => {
    const [state, setState] = createStore({ snapshot: structuredClone(HOOK_FIXTURE_SNAPSHOT) });
    const props = panelProps();
    render(() => <HooksPanel {...props} snapshot={state.snapshot} />);
    await fireEvent.click(screen.getByRole("button", { name: "Edit Workspace audit" }));
    setState((value) => { value.snapshot.revision++; });
    await fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Your draft is kept");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Workspace audit");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("exposes an orphan command in all-hooks view for repair or deletion", async () => {
    const props = panelProps();
    render(() => <HooksPanel {...props} />);
    expect(screen.getByText("Retained command")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Edit Retained command" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ definitions: expect.arrayContaining([
        expect.objectContaining({ id: "fixture-orphan-hook", scope: { kind: "agent", agentId: "fixture-deleted-agent" } }),
      ]) }),
      HOOK_FIXTURE_SNAPSHOT.revision,
    ));
  });

  it("blocks history reset while any firing is active", () => {
    render(() => <HooksPanel {...panelProps()} />);
    expect(screen.getByRole("button", { name: "Reset firing history" })).toBeDisabled();
  });

  it("offers reset after terminal history with the computer master off", () => {
    const snapshot = structuredClone(HOOK_FIXTURE_SNAPSHOT);
    snapshot.runs = snapshot.runs.filter((run) => run.status !== "running");
    render(() => <HooksPanel {...panelProps({ snapshot })} />);
    expect(screen.getByRole("button", { name: "Reset firing history" })).not.toBeDisabled();
  });
});

describe("HookRunItem", () => {
  it("updates the saved firing from running to terminal without an execution action", async () => {
    const [state, setState] = createStore<{ run: HookRun }>({ run: { ...HOOK_FIXTURE_RUN } });
    render(() => <HookRunItem run={state.run} />);
    expect(screen.getByText(/Workspace audit · Turn completed · Running/)).toBeInTheDocument();
    setState((value) => {
      value.run = {
        ...value.run,
        status: "completed",
        finishedAt: "2026-10-13T10:00:00.250Z",
        stdout: "Fixture complete.",
        exitCode: 0,
      };
    });

    await waitFor(() => expect(screen.getByText(/Workspace audit · Turn completed · Completed · 250 ms/)).toBeInTheDocument());
    expect(screen.getByText("Fixture complete.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
