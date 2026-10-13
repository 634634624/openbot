// @vitest-environment node
import type { HookSnapshot, SaveHookSettingsInput } from "@openbot/contracts/ipc-hooks";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookFailure } from "../../backend/hooks/hook-store";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, input?: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, input?: unknown) => unknown) =>
      registrations.set(channel, listener),
  },
}));

import { registerIpcGroup } from "./define-ipc-group";
import { hooksIpcHandlers } from "./hooks-handlers";

const trusted = { senderFrame: { url: "openbot-app://app/index.html" } };
const untrusted = { senderFrame: { url: "https://example.com" } };
function setup(orphan = false) {
  const snapshot: HookSnapshot = {
    localOnly: true,
    revision: 3,
    blockedReason: null,
    runs: [],
    settings: {
      enabled: false,
      agentEnabled: {},
      agentOverrides: {},
      definitions: orphan
        ? [
            {
              id: "hook-1",
              name: "Old bot hook",
              enabled: false,
              scope: { kind: "agent", agentId: "deleted-bot" },
              trigger: "turn.completed",
              command: "echo fixture",
              timeoutMs: 1000,
            },
          ]
        : [],
    },
  };
  const save = vi.fn((_input: SaveHookSettingsInput) => Effect.succeed(snapshot));
  const cancel = vi.fn((_id: string) => Effect.void);
  const reset = vi.fn((_input: { expectedRevision: number }) => Effect.succeed(snapshot));
  registerIpcGroup(
    "hooks",
    hooksIpcHandlers({
      agentIds: () => ["current-bot"],
      hooks: {
        snapshot: () => snapshot,
        saveSettings: save,
        cancelRun: cancel,
        resetHistory: reset,
      },
    }).hooks,
  );
  return { snapshot, save, cancel, reset };
}
beforeEach(() => {
  registrations.clear();
  delete process.env.ELECTRON_RENDERER_URL;
});
describe("trusted local Hooks endpoints", () => {
  it("rejects an outside frame before mutation", () => {
    const { reset } = setup();
    expect(() => registrations.get("hooks:reset-history")?.(untrusted, { expectedRevision: 3 })).toThrow();
    expect(reset).not.toHaveBeenCalled();
  });
  it("rejects malformed settings, cancellation and reset payloads", () => {
    const { save, cancel, reset } = setup();
    for (const channel of ["hooks:save", "hooks:cancel-run", "hooks:reset-history"])
      expect(() => registrations.get(channel)?.(trusted, {})).toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
  it("keeps an existing orphan editable but rejects retargeting to another absent bot", async () => {
    const { snapshot, save } = setup(true);
    const settings = {
      ...snapshot.settings,
      definitions: snapshot.settings.definitions.map((hook) => ({ ...hook, name: "Renamed" })),
    };
    await registrations.get("hooks:save")?.(trusted, { expectedRevision: 3, settings });
    expect(save).toHaveBeenCalledOnce();
    const retargeted = {
      ...settings,
      definitions: settings.definitions.map((hook) => ({
        ...hook,
        scope: { kind: "agent", agentId: "another-missing-bot" },
      })),
    };
    expect(() => registrations.get("hooks:save")?.(trusted, { expectedRevision: 3, settings: retargeted })).toThrow();
    expect(save).toHaveBeenCalledOnce();
  });
  it("refuses a new unknown agent toggle and permits orphan definition deletion", async () => {
    const { snapshot, save } = setup(true);
    expect(() =>
      registrations.get("hooks:save")?.(trusted, {
        expectedRevision: 3,
        settings: {
          ...snapshot.settings,
          agentEnabled: { "new-missing-bot": true },
        },
      }),
    ).toThrow();
    await registrations.get("hooks:save")?.(trusted, {
      expectedRevision: 3,
      settings: { ...snapshot.settings, definitions: [] },
    });
    expect(save).toHaveBeenCalledOnce();
  });
  it("passes an explicit revision to maintenance and returns the validated service snapshot", async () => {
    const { snapshot, reset } = setup();
    await expect(registrations.get("hooks:reset-history")?.(trusted, { expectedRevision: 3 })).resolves.toBe(snapshot);
    expect(reset).toHaveBeenCalledWith({ expectedRevision: 3 });
  });
  it("reports stale settings separately without pretending the rejected save succeeded", async () => {
    const { snapshot } = setup();
    registerIpcGroup(
      "hooks",
      hooksIpcHandlers({
        agentIds: () => [],
        hooks: {
          snapshot: () => snapshot,
          saveSettings: () => Effect.fail(new HookFailure({ reason: "stale" })),
          cancelRun: () => Effect.void,
          resetHistory: () => Effect.fail(new HookFailure({ reason: "stale" })),
        },
      }).hooks,
    );
    await expect(
      registrations.get("hooks:save")?.(trusted, { expectedRevision: 2, settings: snapshot.settings }),
    ).rejects.toThrow(sourceText("error.backend.hooksStale"));
    await expect(registrations.get("hooks:reset-history")?.(trusted, { expectedRevision: 2 })).rejects.toThrow(
      sourceText("error.backend.hooksStale"),
    );
  });
});
