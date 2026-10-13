import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  HOOK_LIMITS,
  type HookDefinition,
  type HookEvent,
  type HookRun,
  type HookSettings,
  type HookSnapshot,
  isHookRun,
  isHookSettings,
  isResetHookHistoryInput,
  isSaveHookSettingsInput,
  type ResetHookHistoryInput,
  type SaveHookSettingsInput,
} from "@openbot/contracts/ipc-hooks";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../atomic-json-file";

export class HookFailure extends Schema.TaggedError<HookFailure>()("HookFailure", {
  reason: Schema.Literals(["storage", "corrupt", "stale", "invalid", "capacity", "unavailable"]),
}) {}

interface StoredHooks {
  version: 1;
  revision: number;
  settings: HookSettings;
  runs: HookRun[];
  seen: string[];
  ledgerFull: boolean;
}
export interface HookStoreOptions {
  path: string;
  changed?: (snapshot: HookSnapshot) => void;
}
interface AcceptedHook {
  run: HookRun;
  definition: HookDefinition;
}
export function emptyHookSettings(): HookSettings {
  return { enabled: false, agentEnabled: {}, agentOverrides: {}, definitions: [] };
}
export function hookApplies(settings: HookSettings, hook: HookDefinition, event: HookEvent): boolean {
  if (!settings.enabled || (Object.hasOwn(settings.agentEnabled, event.agentId) && settings.agentEnabled[event.agentId] === false) || hook.trigger !== event.trigger) return false;
  if (hook.scope.kind === "agent") return hook.scope.agentId === event.agentId && hook.enabled;
  const overrides = Object.hasOwn(settings.agentOverrides, event.agentId) ? settings.agentOverrides[event.agentId] : undefined;
  return overrides && Object.hasOwn(overrides, hook.id) ? overrides[hook.id] : hook.enabled;
}
function validStored(value: unknown): value is StoredHooks {
  return isDynamicRecord(value) && Object.keys(value).every((key) =>
    ["version", "revision", "settings", "runs", "seen", "ledgerFull"].includes(key)) &&
    value.version === 1 && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    isHookSettings(value.settings) && Array.isArray(value.runs) && value.runs.length <= HOOK_LIMITS.recentRuns && value.runs.every(isHookRun) &&
    new Set(value.runs.map((run) => run.id)).size === value.runs.length &&
    Array.isArray(value.seen) && value.seen.length <= HOOK_LIMITS.dedupKeys &&
    value.seen.every((key) => isString(key) && /^[a-f0-9]{64}$/.test(key)) &&
    new Set(value.seen).size === value.seen.length && typeof value.ledgerFull === "boolean";
}

/** One atomic local file holds settings, accepted event keys and recent run receipts. No DDL. */
export class HookStore {
  readonly #gate = Semaphore.makeUnsafe(1);
  #state: StoredHooks = { version: 1, revision: 0, settings: emptyHookSettings(), runs: [], seen: [], ledgerFull: false };
  #ready = false;
  #corrupt = false;
  constructor(private readonly options: HookStoreOptions) {}

  snapshot(): HookSnapshot {
    return structuredClone({
      localOnly: true,
      revision: this.#state.revision,
      settings: this.#state.settings,
      runs: this.#state.runs,
      blockedReason: this.#corrupt ? "corrupt" : this.#state.ledgerFull ? "ledger-full" : null,
    });
  }

  readonly initialize = Effect.fn("HookStore.initialize")(function* (this: HookStore) {
    return yield* this.#gate.withPermits(1)(Effect.gen({ self: this }, function* () {
      if (this.#ready) return this.snapshot();
      const loaded = yield* Effect.tryPromise({
        try: async () => {
          try {
            if ((await stat(this.options.path)).size > 16 * 1024 * 1024) return { corrupt: true };
            const parsed: unknown = JSON.parse(await readFile(this.options.path, "utf8"));
            return validStored(parsed) ? { state: parsed } : { corrupt: true };
          } catch (error) {
            if (isDynamicRecord(error) && error.code === "ENOENT") return { missing: true };
            return { corrupt: true };
          }
        },
        catch: () => new HookFailure({ reason: "storage" }),
      });
      if ("state" in loaded && loaded.state) this.#state = loaded.state;
      if ("corrupt" in loaded) this.#corrupt = true;
      this.#ready = true;
      this.publish();
      return this.snapshot();
    }));
  });

  private readonly persist = Effect.fn("HookStore.persist")(function* (this: HookStore, next: StoredHooks) {
    if (!this.#ready) return yield* new HookFailure({ reason: "unavailable" });
    if (this.#corrupt) return yield* new HookFailure({ reason: "corrupt" });
    yield* writeJsonFileAtomically(this.options.path, next, { createDirectory: true })
      .pipe(Effect.mapError(() => new HookFailure({ reason: "storage" })));
    this.#state = next;
    this.publish();
  });

  private publish(): void {
    try {
      this.options.changed?.(this.snapshot());
    } catch {
      // Observers cannot undo a saved receipt.
    }
  }

  readonly saveSettings = Effect.fn("HookStore.saveSettings")(function* (this: HookStore, input: SaveHookSettingsInput) {
    return yield* this.#gate.withPermits(1)(Effect.gen({ self: this }, function* () {
      if (!isSaveHookSettingsInput(input)) return yield* new HookFailure({ reason: "invalid" });
      if (input.expectedRevision !== this.#state.revision) return yield* new HookFailure({ reason: "stale" });
      if (this.#state.revision === Number.MAX_SAFE_INTEGER) return yield* new HookFailure({ reason: "capacity" });
      yield* this.persist({
        ...this.#state,
        settings: structuredClone(input.settings),
        revision: this.#state.revision + 1,
      });
      return this.snapshot();
    }));
  });

  /** Explicit maintenance only. A later duplicate event may be accepted after this reset. */
  readonly resetHistory = Effect.fn("HookStore.resetHistory")(function* (this: HookStore, input: ResetHookHistoryInput) {
    return yield* this.#gate.withPermits(1)(Effect.gen({ self: this }, function* () {
      if (!isResetHookHistoryInput(input)) return yield* new HookFailure({ reason: "invalid" });
      if (!this.#ready) return yield* new HookFailure({ reason: "unavailable" });
      if (this.#corrupt) return yield* new HookFailure({ reason: "corrupt" });
      if (input.expectedRevision !== this.#state.revision) return yield* new HookFailure({ reason: "stale" });
      if (this.#state.settings.enabled || this.#state.runs.some((run) => run.status === "queued" || run.status === "running")) {
        return yield* new HookFailure({ reason: "unavailable" });
      }
      if (this.#state.revision === Number.MAX_SAFE_INTEGER) return yield* new HookFailure({ reason: "capacity" });
      yield* this.persist({
        ...this.#state,
        revision: this.#state.revision + 1,
        runs: [],
        seen: [],
        ledgerFull: false,
      });
      return this.snapshot();
    }));
  });

  /** Atomically accepts each matching action before any command starts. */
  readonly accept = Effect.fn("HookStore.accept")(function* (this: HookStore, event: HookEvent) {
    return yield* this.#gate.withPermits(1)(Effect.gen({ self: this }, function* () {
      if (!this.#ready || this.#corrupt || this.#state.ledgerFull || event.source === "hook") return [];
      const seen = new Set(this.#state.seen);
      const candidates = this.#state.settings.definitions.filter((hook) => hookApplies(this.#state.settings, hook, event))
        .map((hook) => ({ hook, key: createHash("sha256").update(JSON.stringify([hook.id, event.agentId, event.threadId, event.id])).digest("hex") }))
        .filter(({ key }) => !seen.has(key));
      if (candidates.length === 0) return [];
      if (this.#state.seen.length + candidates.length > HOOK_LIMITS.dedupKeys) {
        yield* this.persist({ ...this.#state, ledgerFull: true });
        return [];
      }
      const unfinished = this.#state.runs.filter((run) => run.status === "queued" || run.status === "running");
      if (unfinished.length + candidates.length > HOOK_LIMITS.recentRuns) return yield* new HookFailure({ reason: "capacity" });
      const runs: HookRun[] = candidates.map(({ hook }) => ({
        id: randomUUID(),
        hookId: hook.id,
        hookName: hook.name,
        eventId: event.id,
        trigger: event.trigger,
        agentId: event.agentId,
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId: event.toolCallId ?? null,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
      }));
      const settled = this.#state.runs.filter((run) => run.status !== "queued" && run.status !== "running");
      const keys = [...this.#state.seen, ...candidates.map(({ key }) => key)];
      yield* this.persist({
        ...this.#state,
        seen: keys,
        ledgerFull: keys.length === HOOK_LIMITS.dedupKeys,
        runs: [...runs, ...unfinished, ...settled.slice(0, HOOK_LIMITS.recentRuns - runs.length - unfinished.length)],
      });
      return candidates.flatMap(({ hook }) => {
        const run = runs.find((item) => item.hookId === hook.id);
        return run ? [{ run: structuredClone(run), definition: structuredClone(hook) } satisfies AcceptedHook] : [];
      });
    }));
  });

  readonly updateRun = Effect.fn("HookStore.updateRun")(function* (this: HookStore, run: HookRun) {
    return yield* this.#gate.withPermits(1)(Effect.gen({ self: this }, function* () {
      if (!isHookRun(run)) return yield* new HookFailure({ reason: "invalid" });
      const previous = this.#state.runs.find((item) => item.id === run.id);
      if (!previous) return yield* new HookFailure({ reason: "invalid" });
      if (previous.status !== "queued" && previous.status !== "running") return previous;
      // A caller can settle a run, but cannot move it to another chat or change its accepted identity.
      const next = {
        ...previous,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
        truncated: run.truncated,
      };
      yield* this.persist({ ...this.#state, runs: this.#state.runs.map((item) => item.id === run.id ? next : item) });
      return structuredClone(next);
    }));
  });
}
