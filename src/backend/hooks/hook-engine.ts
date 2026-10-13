import { type HookDefinition, type HookEvent, type HookRun, isHookEvent } from "@openbot/contracts/ipc-hooks";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Exit, Scope, Semaphore } from "effect";
import { executeHookCommand, type HookCommandExecutor, safeHookOutput } from "./hook-command";
import { HookFailure, type HookStore, hookApplies } from "./hook-store";

export interface HookEngineOptions {
  store: HookStore;
  workspaceForAgent: (agentId: string) => string | null;
  /** The main process can add its registered MCP secret redactor. */
  redact?: (text: string) => string;
  runChanged?: (run: HookRun) => void;
  failure?: (reason: HookFailure["reason"]) => void;
  executor?: HookCommandExecutor;
}
interface PendingHook {
  run: HookRun;
  event: HookEvent;
  definition: HookDefinition;
}

/** Observes lifecycle events. Hook failures never veto or cancel a provider turn. */
export class HookEngine {
  readonly #scope = Scope.makeUnsafe();
  readonly #events = Semaphore.makeUnsafe(1);
  readonly #queue: PendingHook[] = [];
  #active: { id: string; controller: AbortController } | null = null;
  #draining = false;
  #ready = false;
  #stopped = false;
  readonly #executor: HookCommandExecutor;
  constructor(private readonly options: HookEngineOptions) {
    this.#executor = options.executor ?? executeHookCommand;
  }

  readonly initialize = Effect.fn("HookEngine.initialize")(function* (this: HookEngine) {
    yield* this.options.store.initialize();
    if (this.#ready) return;
    for (const run of this.options.store.snapshot().runs) {
      if (run.status === "queued" || run.status === "running") {
        const settled = yield* this.options.store.updateRun({
          ...run,
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          stderr: sourceText("error.backend.hooksRestartInterrupted"),
        });
        this.notify(settled);
      }
    }
    this.#ready = true;
  });

  readonly onEvent = Effect.fn("HookEngine.onEvent")(function* (this: HookEngine, event: HookEvent) {
    return yield* this.#events.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (!isHookEvent(event)) return yield* new HookFailure({ reason: "invalid" });
        if (!this.#ready || this.#stopped || event.source === "hook") return;
        // Do not accept a run for an unknown/deleted agent.
        if (!this.options.workspaceForAgent(event.agentId)) return;
        const accepted = yield* this.options.store.accept(event);
        for (const { run, definition } of accepted) {
          this.notify(run);
          this.#queue.push({ run, event: structuredClone(event), definition });
        }
        if (this.#stopped) {
          for (const pending of this.#queue.splice(0)) {
            yield* this.interrupt(pending.run);
          }
          return;
        }
        if (!this.#draining && this.#queue.length > 0) {
          this.#draining = true;
          yield* this.drain().pipe(
            Effect.catch((failure) => Effect.sync(() => this.reportFailure(failure.reason))),
            Effect.ensuring(
              Effect.sync(() => {
                this.#draining = false;
              }),
            ),
            Effect.forkIn(this.#scope, { startImmediately: true }),
          );
        }
      }),
    );
  });

  private notify(run: HookRun): void {
    try {
      this.options.runChanged?.(structuredClone(run));
    } catch {
      this.reportFailure("storage");
    }
  }

  private reportFailure(reason: HookFailure["reason"]): void {
    try {
      this.options.failure?.(reason);
    } catch {
      // Observers cannot stop command cleanup or affect a provider turn.
    }
  }

  private readonly interrupt = Effect.fn("HookEngine.interrupt")(function* (this: HookEngine, run: HookRun) {
    const updated = yield* this.options.store.updateRun({
      ...run,
      status: "interrupted",
      finishedAt: new Date().toISOString(),
    });
    this.notify(updated);
  });

  private readonly drain = Effect.fn("HookEngine.drain")(function* (this: HookEngine) {
    while (this.#queue.length > 0) {
      const pending = this.#queue.shift();
      if (!pending) break;
      const settings = this.options.store.snapshot().settings;
      const current = settings.definitions.find((hook) => hook.id === pending.run.hookId);
      const cwd = this.options.workspaceForAgent(pending.run.agentId);
      // A queued command is bound to its accepted definition. Disable/edit/delete interrupts it.
      if (
        this.#stopped ||
        !cwd ||
        !current ||
        !hookApplies(settings, current, pending.event) ||
        JSON.stringify(current) !== JSON.stringify(pending.definition)
      ) {
        yield* this.interrupt(pending.run);
        continue;
      }
      const startedAt = new Date().toISOString();
      const running = yield* this.options.store.updateRun({ ...pending.run, status: "running", startedAt });
      this.notify(running);
      // Saving the running receipt can yield. Recheck after it before the process starts.
      const fresh = this.options.store.snapshot().settings;
      const freshDefinition = fresh.definitions.find((hook) => hook.id === current.id);
      const freshRun = this.options.store.snapshot().runs.find((run) => run.id === running.id);
      if (
        this.#stopped ||
        freshRun?.status !== "running" ||
        !freshDefinition ||
        !hookApplies(fresh, freshDefinition, pending.event) ||
        JSON.stringify(freshDefinition) !== JSON.stringify(pending.definition)
      ) {
        yield* this.interrupt(running);
        continue;
      }
      const controller = new AbortController();
      this.#active = { id: running.id, controller };
      const result = yield* Effect.tryPromise({
        try: () =>
          this.#executor({
            command: current.command,
            timeoutMs: current.timeoutMs,
            cwd,
            event: pending.event,
            signal: controller.signal,
          }),
        catch: () => new HookFailure({ reason: "unavailable" }),
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            status: "failed" as const,
            exitCode: null,
            stdout: "",
            stderr: sourceText("error.backend.hooksCommandRun"),
            truncated: false,
          }),
        ),
      );
      this.#active = null;
      const output = safeHookOutput(result.stdout, result.stderr, this.options.redact);
      const settled = yield* this.options.store.updateRun({
        ...running,
        ...result,
        ...output,
        truncated: result.truncated || output.truncated,
        finishedAt: new Date().toISOString(),
      });
      this.notify(settled);
    }
  }, Effect.uninterruptible);

  readonly cancelRun = Effect.fn("HookEngine.cancelRun")(function* (this: HookEngine, runId: string) {
    if (this.#active?.id === runId) {
      this.#active.controller.abort();
      return;
    }
    const index = this.#queue.findIndex((pending) => pending.run.id === runId);
    if (index >= 0) {
      const pending = this.#queue.splice(index, 1)[0];
      if (pending) yield* this.interrupt(pending.run);
      return;
    }
    const run = this.options.store.snapshot().runs.find((item) => item.id === runId);
    if (run?.status === "queued" || run?.status === "running") yield* this.interrupt(run);
  });

  readonly shutdown = Effect.fn("HookEngine.shutdown")(function* (this: HookEngine) {
    this.#stopped = true;
    this.#active?.controller.abort();
    // The drain observes its AbortSignal and settles the receipt before scope disposal returns.
    yield* Scope.close(this.#scope, Exit.void);
    for (const pending of this.#queue.splice(0)) {
      yield* this.interrupt(pending.run);
    }
  }, Effect.uninterruptible);
}
