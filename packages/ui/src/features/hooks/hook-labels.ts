import type { HookRunStatus, HookTrigger } from "@openbot/contracts/ipc-hooks";
import type { AppTextKey } from "@openbot/i18n";

export const HOOK_TRIGGER_LABELS = {
  "turn.started": "hook.trigger.turn.started",
  "turn.completed": "hook.trigger.turn.completed",
  "turn.failed": "hook.trigger.turn.failed",
  "tool.started": "hook.trigger.tool.started",
  "tool.completed": "hook.trigger.tool.completed",
} as const satisfies Record<HookTrigger, AppTextKey>;

export const HOOK_RUN_LABELS = {
  queued: "hook.run.queued",
  running: "hook.run.running",
  completed: "hook.run.completed",
  failed: "hook.run.failed",
  interrupted: "hook.run.interrupted",
  "timed-out": "hook.run.timed-out",
} as const satisfies Record<HookRunStatus, AppTextKey>;
