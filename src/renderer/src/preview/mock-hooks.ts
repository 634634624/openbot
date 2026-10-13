import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { type HookSnapshot, isHookSettings } from "@openbot/contracts/ipc-hooks";
import { sourceText } from "@openbot/i18n/source";

/** The preview stores configuration and history only; it never executes a command. */
export function createMockHooks(initial?: HookSnapshot): OpenBotDesktopApi["hooks"] {
  let snapshot: HookSnapshot = structuredClone(
    initial ?? {
      localOnly: true,
      revision: 0,
      blockedReason: null,
      runs: [],
      settings: { enabled: false, agentEnabled: {}, agentOverrides: {}, definitions: [] },
    },
  );
  const listeners = new Set<(value: HookSnapshot) => void>();
  const publish = () => {
    for (const listener of listeners) listener(structuredClone(snapshot));
  };
  return {
    get: async () => structuredClone(snapshot),
    save: async (input) => {
      if (!isHookSettings(input.settings)) throw new Error(sourceText("error.backend.hooksInvalid"));
      if (input.expectedRevision !== snapshot.revision) throw new Error(sourceText("error.backend.hooksStale"));
      snapshot = { ...snapshot, settings: structuredClone(input.settings), revision: snapshot.revision + 1 };
      publish();
      return structuredClone(snapshot);
    },
    cancelRun: async ({ runId }) => {
      snapshot = {
        ...snapshot,
        runs: snapshot.runs.map((run) =>
          run.id === runId && (run.status === "queued" || run.status === "running")
            ? { ...run, status: "interrupted", finishedAt: new Date().toISOString() }
            : run,
        ),
      };
      publish();
      return structuredClone(snapshot);
    },
    resetHistory: async ({ expectedRevision }) => {
      if (expectedRevision !== snapshot.revision) throw new Error(sourceText("error.backend.hooksStale"));
      if (
        snapshot.settings.enabled ||
        snapshot.blockedReason === "corrupt" ||
        snapshot.runs.some((run) => run.status === "queued" || run.status === "running")
      ) {
        throw new Error(sourceText("error.backend.hooksResetFailed"));
      }
      snapshot = { ...snapshot, runs: [], blockedReason: null, revision: snapshot.revision + 1 };
      publish();
      return structuredClone(snapshot);
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
