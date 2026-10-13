import { type HookSnapshot, isHookSnapshot } from "@openbot/contracts/ipc-hooks";

/** Main-to-renderer validation is separate from the settings input trust boundary. */
export function decodeHookSnapshotFromMain(value: unknown): HookSnapshot {
  if (!isHookSnapshot(value)) throw new Error("Invalid Hooks snapshot from main.");
  return value;
}
