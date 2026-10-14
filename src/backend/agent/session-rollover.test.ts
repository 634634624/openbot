// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestTimeoutError } from "../agent-client";
import type { AgentService } from "../agent-service";
import {
  callOpenBotTool,
  FakeAgentClient,
  openBotToolPayload,
  startAgentTestFixture,
  startService,
  stopAgentTestFixture,
  waitFor,
  waitForQueue,
} from "../agent-service-test-harness";
import { runCauseEffect } from "../effect-boundary";
import { getString } from "../protocol";
import type { SessionCheckpoint } from "./session-checkpoint";

let root: string;
let service: AgentService | null = null;
beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});
afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});
const checkpoint: SessionCheckpoint = {
  status: "open",
  goal: "Complete the approved local report",
  constraints: ["Early constraint: never publish or send the report"],
  authority: ["User approved local report creation only"],
  decisions: ["Use the existing CSV"],
  completed: [{ result: "CSV parsed", evidence: "runs/parsed.json validated" }],
  pending: [{ request: "Write the summary", owner: "chief" }],
  paths: ["runs/parsed.json"],
  nextAction: "Read parsed.json and write the local summary; do not parse the CSV again",
  qualityBoundary: false,
};
function usage(
  client: Awaited<ReturnType<typeof startService>>["client"],
  threadId: string,
  used = 82_000,
  estimated = false,
) {
  client.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      tokenUsage: { last: { totalTokens: used }, modelContextWindow: 100_000, estimated },
    },
  });
}
function complete(
  client: Awaited<ReturnType<typeof startService>>["client"],
  threadId: string,
  turnId: string,
  status = "completed",
) {
  client.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
}
async function running(hook?: (method: string) => Promise<void>) {
  const chosen = new FakeAgentClient("codex", undefined, false, true, {}, hook);
  const base = await startService(root, {
    autoComplete: false,
    client: (provider) => (provider === "codex" ? chosen : new FakeAgentClient(provider, undefined, false)),
  });
  const fixture = { ...base, client: chosen };
  service = fixture.service;
  await runCauseEffect(
    service.sendMessage({ agentId: "chief", text: "Create a local report. Never publish. CSV parsing is complete." }),
  );
  await waitFor(() => service?.getRuntimeSnapshot().activeTurns.length === 1);
  const active = service.getRuntimeSnapshot().activeTurns[0];
  const session = fixture.store.activeProviderSession("chief");
  if (!active || !session) throw new Error("Missing running fixture");
  return { ...fixture, active, session };
}
async function save(fixture: Awaited<ReturnType<typeof running>>, value = checkpoint) {
  const result = await callOpenBotTool(
    fixture.client,
    fixture.session.externalSessionId,
    "session_checkpoint",
    value,
    fixture.active.turnId,
  );
  expect(result.error).toBeUndefined();
  expect(openBotToolPayload(result.result).saved).toBe(true);
}
const journalPath = () =>
  join(root, "user-data", "session-rollovers", createHash("sha256").update("chief").digest("hex"));
async function journal() {
  return JSON.parse(await readFile(journalPath(), "utf8"));
}

describe.sequential("Background structured session rollover", () => {
  it("continues on a different session in the same chat with the early constraint and done evidence", async () => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(() => fixture.client.requests.filter((r) => r.method === "turn/start").length === 2);
    const second = fixture.client.requests.filter((r) => r.method === "turn/start")[1];
    const nextId = getString(second?.params, "threadId");
    expect(nextId).not.toBe(fixture.session.externalSessionId);
    expect(fixture.store.list().find((item) => item.id === "chief")?.threadId).toBe(fixture.active.threadId);
    const text = JSON.stringify(second?.params);
    expect(text).toContain("Early constraint: never publish or send the report");
    expect(text).toContain("CSV parsed");
    expect(text).toContain("do not parse the CSV again");
    expect(fixture.client.releasedThreads).toContain(fixture.session.externalSessionId);
    await waitFor(async () => (await journal()).phase === "accepted");
    expect(fixture.mailbox.listQueue("chief").deliveries).toHaveLength(1);
    // Retired writer notifications cannot claim a turn in the replacement chat.
    fixture.client.emit("notification", {
      method: "turn/started",
      params: { threadId: fixture.session.externalSessionId, turn: { id: "stale-writer" } },
    });
    expect(service?.getRuntimeSnapshot().activeTurns.some((t) => t.turnId === "stale-writer")).toBe(false);
    await mkdir(join(process.cwd(), ".openbot-build", "rollover"), { recursive: true });
    await writeFile(
      join(process.cwd(), ".openbot-build", "rollover", "rollover-e2e.json"),
      JSON.stringify(
        {
          provider: "injected protocol provider",
          oldSession: fixture.session.externalSessionId,
          nextSession: nextId,
          checkpoint: await journal(),
          input: second?.params,
        },
        null,
        2,
      ),
    );
  });

  it.each(["done", "cancelled", "waiting"] as const)("never continues %s work", async (status) => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture, { ...checkpoint, status });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitForQueue(fixture.service, "chief", (q) => q.deliveries[0]?.status === "completed");
    await waitFor(async () => (await journal()).phase === "blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });

  it.each(["below", "missing", "estimated", "unsupported"])("keeps the session for %s telemetry", async (kind) => {
    const fixture = await running();
    if (kind === "unsupported") vi.spyOn(fixture.client, "contextCompaction", "get").mockReturnValue("unsupported");
    if (kind !== "missing")
      usage(
        fixture.client,
        fixture.session.externalSessionId,
        kind === "below" ? 79_000 : 82_000,
        kind === "estimated",
      );
    await save(fixture, { ...checkpoint, qualityBoundary: kind === "unsupported" });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });

  it("accepts an explicit quality boundary for native sessions without pretending estimated usage is exact", async () => {
    const fixture = await running();
    vi.spyOn(fixture.client, "contextCompaction", "get").mockReturnValue("native");
    usage(fixture.client, fixture.session.externalSessionId, 82_000, true);
    await save(fixture, { ...checkpoint, qualityBoundary: true });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "accepted");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(2);
  });

  it("does not reset without a checkpoint and rejects a checkpoint from another turn", async () => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    const refused = await callOpenBotTool(
      fixture.client,
      fixture.session.externalSessionId,
      "session_checkpoint",
      checkpoint,
      "stale-turn",
    );
    expect(refused.result).toMatchObject({ success: false });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitForQueue(fixture.service, "chief", (q) => q.deliveries[0]?.status === "completed");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });

  it("preserves old session and checkpoint after fresh-session start failure; no self retry", async () => {
    let fail = false;
    const fixture = await running(async (method) => {
      if (fail && method === "thread/start") throw new Error("Synthetic start failure");
    });
    const errors: string[] = [];
    fixture.service.on("event", (event) => {
      if (event.type === "error") errors.push(event.code);
    });
    fail = true;
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(() => errors.includes("session_rollover_failed"));
    expect(fixture.store.activeProviderSession("chief")?.externalSessionId).toBe(fixture.session.externalSessionId);
    expect((await journal()).checkpoint.constraints).toEqual(checkpoint.constraints);
    expect((await journal()).phase).toBe("blocked");
    expect(fixture.client.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  it("lets a new user message that arrives during thread creation override continuation exactly once", async () => {
    let arrived!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pause = false;
    const fixture = await running(async (method) => {
      if (pause && method === "thread/start") {
        arrived();
        await barrier;
      }
    });
    pause = true;
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await entering;
    await runCauseEffect(
      fixture.service.sendMessage({ agentId: "chief", text: "Cancel report work. Only answer STOPPED." }),
    );
    release();
    await waitFor(() => fixture.client.requests.filter((r) => r.method === "turn/start").length === 2);
    const starts = fixture.client.requests.filter((r) => r.method === "turn/start");
    expect(JSON.stringify(starts[1]?.params)).toContain("Cancel report work");
    expect(getString(starts[1]?.params, "clientUserMessageId")).not.toContain("session-rollover:");
    expect(fixture.mailbox.listQueue("chief").deliveries).toHaveLength(2);
    expect((await journal()).phase).toBe("blocked");
  });

  it("rejects missing persisted handoff instead of starting an empty fresh turn", async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let pause = false;
    const fixture = await running(async (method) => {
      if (pause && method === "thread/start") {
        entered();
        await barrier;
      }
    });
    pause = true;
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await entering;
    // Fail the persisted handoff write, before the replacement can bind.
    const directory = join(root, "user-data", "provider-handoffs");
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, "owned test obstacle");
    const errors: string[] = [];
    fixture.service.on("event", (event) => {
      if (event.type === "error") errors.push(event.code);
    });
    release();
    await waitFor(() => errors.includes("session_rollover_failed"));
    expect(fixture.store.activeProviderSession("chief")?.externalSessionId).toBe(fixture.session.externalSessionId);
    expect(fixture.client.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });
  it("requires a refreshed checkpoint after a newer input or tool action", async () => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    fixture.client.emit("notification", {
      method: "item/started",
      params: {
        threadId: fixture.session.externalSessionId,
        turnId: fixture.active.turnId,
        item: { id: "later-tool", type: "commandExecution", command: "changed work" },
      },
    });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });

  it("refuses an automatic boundary without new completed progress", async () => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "accepted");
    const first = await journal();
    fixture.client.emit("notification", {
      method: "item/completed",
      params: {
        threadId: first.newSessionId,
        turnId: first.continuationTurnId,
        item: { id: "fresh-comment", type: "agentMessage", text: "Validating the checkpoint" },
      },
    });
    await waitFor(() =>
      fixture.service.getRuntimeSnapshot().activeTurns.some((turn) => turn.turnId === first.continuationTurnId),
    );
    usage(fixture.client, first.newSessionId);
    const result = await callOpenBotTool(
      fixture.client,
      first.newSessionId,
      "session_checkpoint",
      { ...checkpoint, qualityBoundary: true },
      first.continuationTurnId,
    );
    expect(openBotToolPayload(result.result).saved).toBe(true);
    complete(fixture.client, first.newSessionId, first.continuationTurnId);
    await waitFor(async () => (await journal()).phase === "blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(2);
  });

  it("does not replay an uncertain provider turn start or dispatch a second writer", async () => {
    let fail = false;
    const fixture = await running(async (method) => {
      if (fail && method === "turn/start") throw new RequestTimeoutError("Codex", "turn/start");
    });
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    fail = true;
    const errors: string[] = [];
    fixture.service.on("event", (event) => {
      if (event.type === "error") errors.push(event.code);
    });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(() => errors.includes("session_rollover_failed"));
    expect((await journal()).phase).toBe("starting");
    await runCauseEffect(
      fixture.service.sendMessage({ agentId: "chief", text: "New message must wait for the uncertain writer" }),
    );
    await waitForQueue(fixture.service, "chief", (queue) => queue.deliveries[1]?.status === "queued");
    expect(fixture.client.requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
  });

  it("rejects oversized or authority-free checkpoints without replacing the saved state", async () => {
    const fixture = await running();
    await save(fixture);
    const saved = await readFile(journalPath(), "utf8");
    for (const value of [
      { ...checkpoint, authority: [] },
      { ...checkpoint, constraints: ["x".repeat(1201)] },
    ]) {
      const result = await callOpenBotTool(
        fixture.client,
        fixture.session.externalSessionId,
        "session_checkpoint",
        value,
        fixture.active.turnId,
      );
      expect(result.result).toMatchObject({ success: false });
      expect(await readFile(journalPath(), "utf8")).toBe(saved);
    }
  });
  it("honors a Stop even when the provider reports completed", async () => {
    const fixture = await running();
    usage(fixture.client, fixture.session.externalSessionId);
    await save(fixture);
    await runCauseEffect(fixture.service.interrupt("chief", fixture.active.turnId));
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });

  it("lets a newer cancellation invalidate a previously saved checkpoint", async () => {
    const fixture = await running();
    await save(fixture, { ...checkpoint, qualityBoundary: true });
    await runCauseEffect(fixture.service.sendMessage({ agentId: "chief", text: "Cancel the report. Answer STOPPED." }));
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(() => fixture.client.requests.filter((r) => r.method === "turn/start").length === 2);
    expect((await journal()).phase).toBe("blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(JSON.stringify(fixture.client.requests.filter((r) => r.method === "turn/start")[1]?.params)).toContain(
      "Cancel the report",
    );
  });
  it.each([true, false])(
    "continues through three sessions with qualityBoundary=%s and new progress",
    async (qualityBoundary) => {
      const fixture = await running();
      if (!qualityBoundary) usage(fixture.client, fixture.session.externalSessionId);
      await save(fixture, { ...checkpoint, qualityBoundary });
      complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
      await waitFor(async () => (await journal()).phase === "accepted");
      const first = await journal();
      if (!qualityBoundary) usage(fixture.client, first.newSessionId);
      const result = await callOpenBotTool(
        fixture.client,
        first.newSessionId,
        "session_checkpoint",
        {
          ...checkpoint,
          constraints: [],
          qualityBoundary,
          completed: [{ result: "Local summary verified", evidence: "runs/summary.json validated" }],
          nextAction: "Review the summary without parsing CSV or writing it again",
        },
        first.continuationTurnId,
      );
      expect(openBotToolPayload(result.result).saved).toBe(true);
      complete(fixture.client, first.newSessionId, first.continuationTurnId);
      await waitFor(async () => (await journal()).phase === "accepted" && (await journal()).hops === 2);
      expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(3);
      const third = fixture.client.requests.filter((r) => r.method === "turn/start")[2];
      expect(JSON.stringify(third?.params)).toContain(checkpoint.constraints[0]);
      expect(JSON.stringify(third?.params)).toContain("CSV parsed");
      expect(JSON.stringify(third?.params)).toContain("Local summary verified");
      expect(fixture.mailbox.listQueue("chief").deliveries).toHaveLength(1);
      const second = await journal();
      await runCauseEffect(fixture.service.interrupt("chief", second.continuationTurnId));
      await callOpenBotTool(
        fixture.client,
        second.newSessionId,
        "session_checkpoint",
        {
          ...checkpoint,
          qualityBoundary: true,
          completed: [...second.checkpoint.completed, { result: "Review verified", evidence: "runs/review.json" }],
        },
        second.continuationTurnId,
      );
      complete(fixture.client, second.newSessionId, second.continuationTurnId);
      await waitFor(async () => (await journal()).phase === "blocked");
      expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(3);
    },
  );

  it("bounds even successive progress to eight automatic hops", async () => {
    const fixture = await running();
    await save(fixture, { ...checkpoint, qualityBoundary: true });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "accepted");
    for (let hop = 1; hop <= 8; hop++) {
      const current = await journal();
      expect(current.hops).toBe(hop);
      await callOpenBotTool(
        fixture.client,
        current.newSessionId,
        "session_checkpoint",
        {
          ...checkpoint,
          qualityBoundary: true,
          completed: [
            ...current.checkpoint.completed,
            { result: `Verified stage ${hop}`, evidence: `runs/stage-${hop}.json` },
          ],
        },
        current.continuationTurnId,
      );
      complete(fixture.client, current.newSessionId, current.continuationTurnId);
      await waitFor(async () => {
        const next = await journal();
        return hop === 8 ? next.phase === "blocked" : next.phase === "accepted" && next.hops === hop + 1;
      });
    }
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(9);
  });

  it.each(["checkpoint", "starting"])("holds safely after actual process death at %s without replay", async (phase) => {
    let failure: unknown;
    try {
      await promisify(execFile)(
        "node",
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--project",
          "node",
          "src/backend/agent/session-rollover-crash.test.ts",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENBOT_ROLLOVER_CRASH_ROOT: root, OPENBOT_ROLLOVER_CRASH_PHASE: phase },
          maxBuffer: 2_000_000,
        },
      );
    } catch (error) {
      failure = error;
    }
    await mkdir(join(process.cwd(), ".openbot-build", "rollover"), { recursive: true });
    await writeFile(
      join(process.cwd(), ".openbot-build", "rollover", `crash-${phase}.log`),
      (getString(failure, "stdout") ?? "") + (getString(failure, "stderr") ?? ""),
    );
    // Vitest isolates AgentService in a worker process; killing that actual writer makes its controller exit 1.
    expect(failure).toMatchObject({ code: 1 });
    expect(getString(failure, "stderr") ?? "").toContain("Worker exited unexpectedly");
    const receipt = JSON.parse(await readFile(join(root, "crash-receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ phase });
    expect(receipt.pid).toBeGreaterThan(0);
    const saved = await journal();
    expect(saved.phase).toBe(phase);
    const fixture = await startService(root, { autoComplete: false });
    service = fixture.service;
    const errors: string[] = [];
    service.on("event", (event) => {
      if (event.type === "error") errors.push(event.code);
    });
    await runCauseEffect(
      service.sendMessage({ agentId: "chief", text: "New authoritative request waits for recovered writer" }),
    );
    await waitForQueue(service, "chief", (queue) => queue.deliveries.at(-1)?.status === "queued");
    expect(fixture.client.requests.filter((r) => r.method === "turn/start")).toHaveLength(0);
    expect(await journal()).toEqual({ ...saved, phase: "held" });
    const active = saved.newSessionId ?? saved.oldSessionId;
    const recoveredTurn = phase === "starting" ? "recovered-uncertain-turn" : saved.turnId;
    fixture.client.emit("notification", {
      method: "turn/started",
      params: {
        threadId: active,
        turn: { id: recoveredTurn },
        unprompted: true,
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().activeTurns.length === 1);
    expect(fixture.client.requests.filter((r) => r.method === "turn/start")).toHaveLength(0);
    complete(fixture.client, active, recoveredTurn, "interrupted");
    await waitFor(() => fixture.client.requests.filter((r) => r.method === "turn/start").length === 1);
    expect(JSON.stringify(fixture.client.requests.find((r) => r.method === "turn/start")?.params)).toContain(
      "New authoritative request",
    );
    await writeFile(
      join(process.cwd(), ".openbot-build", "rollover", `restart-${phase}.json`),
      JSON.stringify(
        {
          crashReceipt: receipt,
          savedJournal: saved,
          recoveredSession: active,
          recoveredTurn,
          replayedAutomaticRequests: 0,
          requestsAfterConfirmedCompletion: fixture.client.requests.filter((r) => r.method === "turn/start"),
          queue: fixture.mailbox.listQueue("chief"),
        },
        null,
        2,
      ),
    );
  });

  it("lets a new message supersede a progressed automatic checkpoint", async () => {
    const fixture = await running();
    await save(fixture, { ...checkpoint, qualityBoundary: true });
    complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
    await waitFor(async () => (await journal()).phase === "accepted");
    const next = await journal();
    await callOpenBotTool(
      fixture.client,
      next.newSessionId,
      "session_checkpoint",
      {
        ...checkpoint,
        qualityBoundary: true,
        completed: [...checkpoint.completed, { result: "Summary verified", evidence: "runs/summary.json" }],
      },
      next.continuationTurnId,
    );
    await runCauseEffect(
      fixture.service.sendMessage({
        agentId: "chief",
        text: "Cancel the previous task; new instructions take precedence",
      }),
    );
    complete(fixture.client, next.newSessionId, next.continuationTurnId);
    await waitFor(() => fixture.client.requests.filter((r) => r.method === "turn/start").length === 3);
    expect((await journal()).phase).toBe("blocked");
    expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(2);
    expect(JSON.stringify(fixture.client.requests.filter((r) => r.method === "turn/start")[2]?.params)).toContain(
      "new instructions take precedence",
    );
  });
  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "keeps post-checkpoint invalidation after a failed checkpoint write",
    async () => {
      const fixture = await running();
      await save(fixture, { ...checkpoint, qualityBoundary: true });
      fixture.client.emit("notification", {
        method: "item/started",
        params: {
          threadId: fixture.session.externalSessionId,
          turnId: fixture.active.turnId,
          item: { id: "changed-state", type: "commandExecution", command: "local state changed" },
        },
      });
      const directory = join(root, "user-data", "session-rollovers");
      await chmod(directory, 0o500);
      try {
        const result = await callOpenBotTool(
          fixture.client,
          fixture.session.externalSessionId,
          "session_checkpoint",
          { ...checkpoint, qualityBoundary: true },
          fixture.active.turnId,
        );
        expect(result.result).toMatchObject({ success: false });
      } finally {
        await chmod(directory, 0o700);
      }
      complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
      await waitFor(async () => (await journal()).phase === "blocked");
      expect(fixture.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    },
  );
});
