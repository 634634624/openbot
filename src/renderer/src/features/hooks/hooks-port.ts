import type { HookSettings, HookSnapshot } from "@openbot/contracts/ipc-hooks";

export interface HooksPort {
  get: () => Promise<HookSnapshot>;
  save: (settings: HookSettings, expectedRevision: number) => Promise<HookSnapshot>;
  cancelRun: (runId: string) => Promise<HookSnapshot>;
  resetHistory: (expectedRevision: number) => Promise<HookSnapshot>;
  subscribe: (listener: (snapshot: HookSnapshot) => void) => () => void;
}

/** Callers supply this port only for the local server. There is no remote fallback. */
export const desktopHooksPort: HooksPort = {
  get: () => window.openbot.hooks.get(),
  save: (settings, expectedRevision) => window.openbot.hooks.save({ settings, expectedRevision }),
  cancelRun: (runId) => window.openbot.hooks.cancelRun({ runId }),
  resetHistory: (expectedRevision) => window.openbot.hooks.resetHistory({ expectedRevision }),
  subscribe: (listener) => window.openbot.hooks.onChanged(listener),
};
