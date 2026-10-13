import type { HookRun, HookSnapshot } from "@openbot/contracts/ipc-hooks";

/** Synthetic data shared by source-only tests and Storybook. No command is executed here. */
export const HOOK_FIXTURE_AGENTS = [{ id: "fixture-agent", name: "Harbor" }, { id: "fixture-agent-other", name: "Beacon" }];
export const HOOK_FIXTURE_RUN: HookRun = {
  id: "fixture-run", hookId: "fixture-global-hook", hookName: "Workspace audit", eventId: "fixture-event",
  trigger: "turn.completed", agentId: "fixture-agent", threadId: "fixture-thread", turnId: "fixture-turn",
  toolCallId: null, status: "running", startedAt: "2026-10-13T10:00:00.000Z", finishedAt: null,
  exitCode: null, stdout: "", stderr: "", truncated: false,
};
export const HOOK_FIXTURE_SNAPSHOT: HookSnapshot = {
  localOnly: true, revision: 1, blockedReason: null,
  settings: {
    enabled: false, agentEnabled: {}, agentOverrides: { "fixture-agent": { "fixture-global-hook": false } },
    definitions: [
      { id: "fixture-global-hook", name: "Workspace audit", enabled: true, scope: { kind: "global" }, trigger: "turn.completed", command: "printf '%s\\n' 'fixture only'", timeoutMs: 10000 },
      { id: "fixture-agent-hook", name: "Local checklist", enabled: false, scope: { kind: "agent", agentId: "fixture-agent" }, trigger: "turn.started", command: "printf '%s\\n' 'fixture only'", timeoutMs: 5000 },
      { id: "fixture-orphan-hook", name: "Retained command", enabled: false, scope: { kind: "agent", agentId: "fixture-deleted-agent" }, trigger: "turn.failed", command: "printf '%s\\n' 'fixture only'", timeoutMs: 5000 },
    ],
  },
  runs: [HOOK_FIXTURE_RUN,
    { ...HOOK_FIXTURE_RUN, id: "fixture-failed-run", eventId: "fixture-failed-event", status: "timed-out", finishedAt: "2026-10-13T10:00:10.000Z", stderr: "Synthetic timeout output." },
    { ...HOOK_FIXTURE_RUN, id: "fixture-complete-run", eventId: "fixture-complete-event", status: "completed", finishedAt: "2026-10-13T10:00:00.250Z", exitCode: 0, stdout: "Synthetic audit completed." },
  ],
};
