import { type HookSnapshot, isHookSnapshot } from "@openbot/contracts/ipc-hooks";

/** Local-only IPC. Hooks have no remote-host endpoint or FromHost/FromMain decoder pair. */
export function decodeLocalHookSnapshot(value: unknown): HookSnapshot {
  if (!isHookSnapshot(value)) throw new Error("Invalid Hooks snapshot from main.");
  return value;
}
