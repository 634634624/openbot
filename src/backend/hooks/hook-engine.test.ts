// Authored for CHA-564. Do not run without the user's permission to execute checks.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_LIMITS, type HookDefinition, type HookEvent, type HookRun } from "@openbot/contracts/ipc-hooks";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HookCommandExecutor, type HookCommandResult, safeHookOutput } from "./hook-command";
import { HookEngine } from "./hook-engine";
import { emptyHookSettings, HookStore } from "./hook-store";

let root: string;
let engines: HookEngine[];
const event: HookEvent = {
  id: "event-1",
  trigger: "turn.completed",
  agentId: "agent-one",
  threadId: "thread-one",
  turnId: "turn-one",
};
const definition: HookDefinition = {
  id: "hook-one",
  name: "One action",
  enabled: true,
  scope: { kind: "global" },
  trigger: "turn.completed",
  command: "user configured action",
  timeoutMs: 1000,
};
const completed: HookCommandResult = { status: "completed", exitCode: 0, stdout: "done", stderr: "", truncated: false };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-hooks-"));
  engines = [];
});
afterEach(async () => {
  for (const engine of engines) await Effect.runPromise(engine.shutdown());
  await rm(root, { recursive: true, force: true });
});
async function setup(executor: HookCommandExecutor, runChanged?: (run: HookRun) => void) {
  const path = join(root, "hooks.json");
  const store = new HookStore({ path });
  const engine = new HookEngine({
    store,
    executor,
    workspaceForAgent: (id) => (id === event.agentId ? root : null),
    runChanged,
  });
  engines.push(engine);
  await Effect.runPromise(engine.initialize());
  await Effect.runPromise(
    store.saveSettings({
      expectedRevision: 0,
      settings: { ...emptyHookSettings(), enabled: true, definitions: [definition] },
    }),
  );
  return { store, engine, path };
}
describe.sequential("local lifecycle hooks", () => {
  it("starts disabled and preserves corrupt input without rewriting it", async () => {
    const path = join(root, "hooks.json");
    const first = new HookStore({ path });
    await Effect.runPromise(first.initialize());
    expect(first.snapshot().settings.enabled).toBe(false);
    const corrupt = '{"version":99,"command":"do not run"}';
    await writeFile(path, corrupt);
    const store = new HookStore({ path });
    await Effect.runPromise(store.initialize());
    expect(store.snapshot().blockedReason).toBe("corrupt");
    await expect(
      Effect.runPromise(store.saveSettings({ expectedRevision: 0, settings: emptyHookSettings() })),
    ).rejects.toBeDefined();
    await expect(Effect.runPromise(store.resetHistory({ expectedRevision: 0 }))).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("rejects stale settings and never changes the accepted command", async () => {
    const { store } = await setup(async () => completed);
    await Effect.runPromise(store.saveSettings({ expectedRevision: 1, settings: emptyHookSettings() }));
    await expect(
      Effect.runPromise(
        store.saveSettings({
          expectedRevision: 1,
          settings: { ...emptyHookSettings(), enabled: true, definitions: [definition] },
        }),
      ),
    ).rejects.toBeDefined();
    expect(store.snapshot().revision).toBe(2);
    expect(store.snapshot().settings.enabled).toBe(false);
  });

  it("runs once for a duplicate and sends only lifecycle metadata to the injected executor", async () => {
    const terminal = deferred<HookRun>();
    const requests: HookEvent[] = [];
    const { store, engine } = await setup(
      async (request) => {
        requests.push(request.event);
        return completed;
      },
      (run) => {
        if (run.status === "completed") terminal.resolve(run);
      },
    );
    await Effect.runPromise(engine.onEvent(event));
    await terminal.promise;
    await Effect.runPromise(engine.onEvent(event));
    await Effect.runPromise(engine.onEvent({ ...event, id: "hook-emitted", source: "hook" }));
    expect(requests).toEqual([event]);
    expect(store.snapshot().runs).toHaveLength(1);
    expect(store.snapshot().runs[0]?.threadId).toBe(event.threadId);
  });

  it("does not start a queued command after the master is disabled", async () => {
    const started = deferred<void>();
    const release = deferred<HookCommandResult>();
    const secondTerminal = deferred<void>();
    let calls = 0;
    const { store, engine } = await setup(
      async () => {
        calls++;
        started.resolve();
        return release.promise;
      },
      (run) => {
        if (run.eventId === "event-2" && run.status === "interrupted") secondTerminal.resolve();
      },
    );
    await Effect.runPromise(engine.onEvent(event));
    await started.promise;
    await Effect.runPromise(engine.onEvent({ ...event, id: "event-2" }));
    const snapshot = store.snapshot();
    await Effect.runPromise(
      store.saveSettings({ expectedRevision: snapshot.revision, settings: { ...snapshot.settings, enabled: false } }),
    );
    release.resolve(completed);
    await secondTerminal.promise;
    expect(calls).toBe(1);
    expect(store.snapshot().runs.find((run) => run.eventId === "event-2")?.status).toBe("interrupted");
  });

  it("cancels the active executor and persists interrupted instead of success", async () => {
    const started = deferred<void>();
    const terminal = deferred<HookRun>();
    const { engine, store } = await setup(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve({ ...completed, status: "interrupted", exitCode: null }),
            { once: true },
          );
          started.resolve();
        }),
      (run) => {
        if (run.status === "interrupted") terminal.resolve(run);
      },
    );
    await Effect.runPromise(engine.onEvent(event));
    await started.promise;
    const run = store.snapshot().runs[0];
    if (!run) throw new Error("Expected a running hook to cancel");
    await Effect.runPromise(engine.cancelRun(run.id));
    expect((await terminal.promise).status).toBe("interrupted");
  });

  it("marks accepted work interrupted on restart without executing it again", async () => {
    const { store, path } = await setup(async () => completed);
    await Effect.runPromise(store.accept(event));
    let called = false;
    const recovered = new HookStore({ path });
    const engine = new HookEngine({
      store: recovered,
      workspaceForAgent: () => root,
      executor: async () => {
        called = true;
        return completed;
      },
    });
    engines.push(engine);
    await Effect.runPromise(engine.initialize());
    await Effect.runPromise(engine.onEvent(event));
    expect(called).toBe(false);
    expect(recovered.snapshot().runs[0]?.status).toBe("interrupted");
  });

  it("bounds combined output bytes after redaction", () => {
    const output = safeHookOutput(`private-marker${"😀".repeat(HOOK_LIMITS.outputBytes)}`, "error", (text) =>
      text.replaceAll("private-marker", "[redacted]"),
    );
    expect(output.stdout).not.toContain("private-marker");
    expect(Buffer.byteLength(output.stdout + output.stderr)).toBeLessThanOrEqual(HOOK_LIMITS.outputBytes);
    expect(output.truncated).toBe(true);
  });

  it("resets history only while disabled and settled, preserving settings without replay", async () => {
    let calls = 0;
    const { store } = await setup(async () => {
      calls++;
      return completed;
    });
    await expect(Effect.runPromise(store.resetHistory({ expectedRevision: 1 }))).rejects.toBeDefined();
    const [accepted] = await Effect.runPromise(store.accept(event));
    if (!accepted) throw new Error("Expected an accepted hook run");
    const before = store.snapshot();
    const disabled = { ...before.settings, enabled: false };
    await Effect.runPromise(store.saveSettings({ expectedRevision: before.revision, settings: disabled }));
    await expect(Effect.runPromise(store.resetHistory({ expectedRevision: 2 }))).rejects.toBeDefined();
    await Effect.runPromise(
      store.updateRun({ ...accepted.run, status: "interrupted", finishedAt: new Date().toISOString() }),
    );
    await expect(Effect.runPromise(store.resetHistory({ expectedRevision: 1 }))).rejects.toBeDefined();
    const reset = await Effect.runPromise(store.resetHistory({ expectedRevision: 2 }));
    expect(reset.revision).toBe(3);
    expect(reset.settings).toEqual(disabled);
    expect(reset.runs).toEqual([]);
    expect(reset.blockedReason).toBeNull();
    expect(calls).toBe(0);
    const reopened = new HookStore({ path: join(root, "hooks.json") });
    await Effect.runPromise(reopened.initialize());
    expect(reopened.snapshot()).toEqual(reset);
    await Effect.runPromise(reopened.saveSettings({ expectedRevision: 3, settings: before.settings }));
    expect(await Effect.runPromise(reopened.accept(event))).toHaveLength(1);
  });

  it("explicitly reopens a full ledger without changing definitions or enabling hooks", async () => {
    const path = join(root, "hooks.json");
    const settings = { ...emptyHookSettings(), definitions: [definition], agentEnabled: { "agent-one": false } };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        revision: 4,
        settings,
        runs: [],
        seen: Array.from({ length: HOOK_LIMITS.dedupKeys }, (_, index) => index.toString(16).padStart(64, "0")),
        ledgerFull: true,
      }),
    );
    const store = new HookStore({ path });
    await Effect.runPromise(store.initialize());
    expect(store.snapshot().blockedReason).toBe("ledger-full");
    const reset = await Effect.runPromise(store.resetHistory({ expectedRevision: 4 }));
    expect(reset.blockedReason).toBeNull();
    expect(reset.settings).toEqual(settings);
    expect(reset.revision).toBe(5);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.seen).toEqual([]);
    expect(persisted.ledgerFull).toBe(false);
  });
});
