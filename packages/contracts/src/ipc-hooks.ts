import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

/** These hooks are local OpenBot actions. They do not alter provider safety hooks. */
export const HOOK_TRIGGERS = [
  "turn.started",
  "turn.completed",
  "turn.failed",
  "tool.started",
  "tool.completed",
] as const;
export type HookTrigger = (typeof HOOK_TRIGGERS)[number];
export const HOOK_RUN_STATUSES = ["queued", "running", "completed", "failed", "interrupted", "timed-out"] as const;
export type HookRunStatus = (typeof HOOK_RUN_STATUSES)[number];
export const HOOK_LIMITS = {
  definitions: 100,
  agentSettings: 1000,
  name: 160,
  command: 8000,
  minTimeoutMs: 100,
  maxTimeoutMs: 300_000,
  outputBytes: 16_384,
  recentRuns: 200,
  dedupKeys: 20_000,
} as const;

export interface HookDefinition {
  id: string;
  name: string;
  enabled: boolean;
  scope: { kind: "global" } | { kind: "agent"; agentId: string };
  trigger: HookTrigger;
  /** Only trusted local settings can set this shell command. Events are JSON on stdin. */
  command: string;
  timeoutMs: number;
}
export interface HookSettings {
  enabled: boolean;
  /** Missing means on; the global master still defaults to off. */
  agentEnabled: Record<string, boolean>;
  /** Outer key is agent id, inner key is global hook id. Missing inherits hook.enabled. */
  agentOverrides: Record<string, Record<string, boolean>>;
  definitions: HookDefinition[];
}
export interface HookEvent {
  id: string;
  trigger: HookTrigger;
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  toolCallId?: string;
  toolName?: string;
  source?: "agent" | "hook";
}
export interface HookRun {
  id: string;
  hookId: string;
  hookName: string;
  eventId: string;
  trigger: HookTrigger;
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  status: HookRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface HookSnapshot {
  localOnly: true;
  /** Settings revision. History changes do not invalidate an open settings editor. */
  revision: number;
  settings: HookSettings;
  runs: HookRun[];
  blockedReason: "corrupt" | "ledger-full" | null;
}
export interface SaveHookSettingsInput {
  settings: HookSettings;
  expectedRevision: number;
}
export interface CancelHookRunInput {
  runId: string;
}
/** Explicit local maintenance; does not execute or replay any event. */
export interface ResetHookHistoryInput {
  expectedRevision: number;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function keys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function booleanMap(value: unknown, maximum: number): value is Record<string, boolean> {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).length <= maximum &&
    Object.entries(value).every(([key, item]) => isIdentifier(key) && isBoolean(item))
  );
}
function nullableId(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}
function nullableDate(value: unknown): value is string | null {
  return value === null || (isBoundedString(value, 64) && Number.isFinite(Date.parse(value)));
}
export function isHookDefinition(value: unknown): value is HookDefinition {
  if (!isDynamicRecord(value) || !keys(value, ["id", "name", "enabled", "scope", "trigger", "command", "timeoutMs"]))
    return false;
  const scope = value.scope;
  return (
    isIdentifier(value.id) &&
    isBoundedString(value.name, HOOK_LIMITS.name) &&
    value.name.trim().length > 0 &&
    isBoolean(value.enabled) &&
    isDynamicRecord(scope) &&
    ((scope.kind === "global" && keys(scope, ["kind"])) ||
      (scope.kind === "agent" && keys(scope, ["kind", "agentId"]) && isIdentifier(scope.agentId))) &&
    isOneOf(HOOK_TRIGGERS, value.trigger) &&
    isBoundedString(value.command, HOOK_LIMITS.command) &&
    value.command.trim().length > 0 &&
    !value.command.includes("\0") &&
    integer(value.timeoutMs, HOOK_LIMITS.minTimeoutMs, HOOK_LIMITS.maxTimeoutMs)
  );
}
export function isHookSettings(value: unknown): value is HookSettings {
  if (!isDynamicRecord(value) || !keys(value, ["enabled", "agentEnabled", "agentOverrides", "definitions"]))
    return false;
  if (
    !isBoolean(value.enabled) ||
    !booleanMap(value.agentEnabled, HOOK_LIMITS.agentSettings) ||
    !isDynamicRecord(value.agentOverrides) ||
    Object.keys(value.agentOverrides).length > HOOK_LIMITS.agentSettings ||
    !Array.isArray(value.definitions) ||
    value.definitions.length > HOOK_LIMITS.definitions ||
    !value.definitions.every(isHookDefinition)
  )
    return false;
  const ids = new Set(value.definitions.map((hook) => hook.id));
  const globalIds = new Set(value.definitions.filter((hook) => hook.scope.kind === "global").map((hook) => hook.id));
  return (
    ids.size === value.definitions.length &&
    Object.entries(value.agentOverrides).every(
      ([agentId, overrides]) =>
        isIdentifier(agentId) &&
        booleanMap(overrides, HOOK_LIMITS.definitions) &&
        Object.keys(overrides).every((id) => globalIds.has(id)),
    )
  );
}
export function isHookEvent(value: unknown): value is HookEvent {
  return (
    isDynamicRecord(value) &&
    keys(value, ["id", "trigger", "agentId", "threadId", "turnId", "toolCallId", "toolName", "source"]) &&
    isIdentifier(value.id) &&
    isOneOf(HOOK_TRIGGERS, value.trigger) &&
    isIdentifier(value.agentId) &&
    nullableId(value.threadId) &&
    nullableId(value.turnId) &&
    (value.toolCallId === undefined || isIdentifier(value.toolCallId)) &&
    (value.toolName === undefined || isBoundedString(value.toolName, 256)) &&
    (value.source === undefined || isOneOf(["agent", "hook"], value.source))
  );
}
export function isHookRun(value: unknown): value is HookRun {
  return (
    isDynamicRecord(value) &&
    keys(value, [
      "id",
      "hookId",
      "hookName",
      "eventId",
      "trigger",
      "agentId",
      "threadId",
      "turnId",
      "toolCallId",
      "status",
      "startedAt",
      "finishedAt",
      "exitCode",
      "stdout",
      "stderr",
      "truncated",
    ]) &&
    isIdentifier(value.id) &&
    isIdentifier(value.hookId) &&
    isBoundedString(value.hookName, HOOK_LIMITS.name) &&
    isIdentifier(value.eventId) &&
    isOneOf(HOOK_TRIGGERS, value.trigger) &&
    isIdentifier(value.agentId) &&
    nullableId(value.threadId) &&
    nullableId(value.turnId) &&
    nullableId(value.toolCallId) &&
    isOneOf(HOOK_RUN_STATUSES, value.status) &&
    nullableDate(value.startedAt) &&
    nullableDate(value.finishedAt) &&
    (value.exitCode === null || integer(value.exitCode, -2_147_483_648, 2_147_483_647)) &&
    isBoundedString(value.stdout, HOOK_LIMITS.outputBytes) &&
    isBoundedString(value.stderr, HOOK_LIMITS.outputBytes) &&
    new TextEncoder().encode(value.stdout + value.stderr).byteLength <= HOOK_LIMITS.outputBytes &&
    isBoolean(value.truncated)
  );
}
export function isHookSnapshot(value: unknown): value is HookSnapshot {
  return (
    isDynamicRecord(value) &&
    keys(value, ["localOnly", "revision", "settings", "runs", "blockedReason"]) &&
    value.localOnly === true &&
    integer(value.revision, 0, Number.MAX_SAFE_INTEGER) &&
    isHookSettings(value.settings) &&
    Array.isArray(value.runs) &&
    value.runs.length <= HOOK_LIMITS.recentRuns &&
    value.runs.every(isHookRun) &&
    (value.blockedReason === null || isOneOf(["corrupt", "ledger-full"], value.blockedReason))
  );
}
export function isSaveHookSettingsInput(value: unknown): value is SaveHookSettingsInput {
  return (
    isDynamicRecord(value) &&
    keys(value, ["settings", "expectedRevision"]) &&
    isHookSettings(value.settings) &&
    integer(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
  );
}
export function isCancelHookRunInput(value: unknown): value is CancelHookRunInput {
  return isDynamicRecord(value) && keys(value, ["runId"]) && isIdentifier(value.runId);
}
export function isResetHookHistoryInput(value: unknown): value is ResetHookHistoryInput {
  return (
    isDynamicRecord(value) &&
    keys(value, ["expectedRevision"]) &&
    integer(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
  );
}
