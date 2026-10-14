// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRoutineStore } from "../agent-routine-store";
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
import { getString, type ResponseDecoder } from "../protocol";
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
function complete(
  client: Awaited<ReturnType<typeof startService>>["client"],
  threadId: string,
  turnId: string,
  status = "completed",
) {
  client.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
}
async function running(hook?: (method: string) => Promise<void>, client?: FakeAgentClient) {
  const chosen = client ?? new FakeAgentClient("codex", undefined, false, true, {}, hook);
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

describe.sequential("Oracle acceptance rollover terminal recovery", () => {
  it.each(["completed", "interrupted", "failed"])(
    "does not hold a known %s continuation after restart",
    async (status) => {
      const fixture = await running();
      await save(fixture, { ...checkpoint, qualityBoundary: true });
      complete(fixture.client, fixture.session.externalSessionId, fixture.active.turnId);
      await waitFor(async () => (await journal()).phase === "accepted");
      const accepted = await journal();
      complete(fixture.client, accepted.newSessionId, accepted.continuationTurnId, status);
      await waitFor(() => fixture.service.getRuntimeSnapshot().activeTurns.length === 0);
      const terminal = await journal();
      await runCauseEffect(fixture.service.stop());
      service = null;
      const restarted = await startService(root, { autoComplete: false });
      service = restarted.service;
      const recovered = await journal();
      await mkdir(join(process.cwd(), ".openbot-build", "rollover"), { recursive: true });
      await writeFile(
        join(process.cwd(), ".openbot-build", "rollover", `repair-terminal-${status}.json`),
        JSON.stringify({ status, terminal, recovered }, null, 2),
      );
      await runCauseEffect(
        restarted.service.sendMessage({ agentId: "chief", text: "Start a new approved local task" }),
      );
      await waitFor(() => restarted.service.getRuntimeSnapshot().activeTurns.length === 1);
      expect(restarted.client.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
      expect(recovered.phase, `Known terminal ${status} must not wait for an already completed writer`).not.toBe(
        "held",
      );
    },
  );
});

describe.sequential("Oracle acceptance delegated rollover", () => {
  it("keeps the original delegated request open while its automatic continuation runs", async () => {
    const fixture = await running();
    await runCauseEffect(fixture.store.getOrCreate("worker"));
    const sent = await callOpenBotTool(
      fixture.client,
      fixture.session.externalSessionId,
      "send_message",
      {
        recipientAgentIds: ["worker"],
        text: "Finish the approved report",
        expectsReply: true,
      },
      fixture.active.turnId,
    );
    expect(sent.error).toBeUndefined();
    await waitForQueue(fixture.service, "worker", (q) => q.deliveries[0]?.status === "running");
    const turn = fixture.service.listQueue("worker").deliveries[0]?.turnId;
    if (!turn) throw new Error("Missing worker turn");
    const session = fixture.store.activeProviderSession("worker")?.externalSessionId;
    if (!session) throw new Error("Missing worker session");
    const saved = await callOpenBotTool(
      fixture.client,
      session,
      "session_checkpoint",
      { ...checkpoint, qualityBoundary: true },
      turn,
    );
    expect(openBotToolPayload(saved.result).saved).toBe(true);
    complete(fixture.client, session, turn);
    const path = join(root, "user-data", "session-rollovers", createHash("sha256").update("worker").digest("hex"));
    await waitFor(async () => JSON.parse(await readFile(path, "utf8")).phase === "accepted");
    const queue = fixture.service.listQueue("worker");
    expect(queue.deliveries[0]?.status).toBe("running");
    await writeFile(
      join(process.cwd(), ".openbot-build", "rollover", "repair-delegated-review.json"),
      JSON.stringify({ queue, journal: JSON.parse(await readFile(path, "utf8")) }, null, 2),
    );
    const next = JSON.parse(await readFile(path, "utf8"));
    const item = { id: "oracle-final-result", type: "agentMessage", text: "FINAL_REPORT_READY", phase: "final_answer" };
    fixture.client.emit("notification", {
      method: "item/started",
      params: { threadId: next.newSessionId, turnId: next.continuationTurnId, item: { ...item, text: "" } },
    });
    fixture.client.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: next.newSessionId, turnId: next.continuationTurnId, itemId: item.id, delta: item.text },
    });
    fixture.client.emit("notification", {
      method: "item/completed",
      params: { threadId: next.newSessionId, turnId: next.continuationTurnId, item },
    });
    complete(fixture.client, next.newSessionId, next.continuationTurnId);
    await waitFor(() => !fixture.service.getRuntimeSnapshot().activeTurns.some((t) => t.agentId === "worker"));
    const requester = fixture.service.listQueue("chief");
    await writeFile(
      join(process.cwd(), ".openbot-build", "rollover", "repair-delegated-review.json"),
      JSON.stringify({ queue, requester, journal: next }, null, 2),
    );
    expect(
      requester.deliveries.some((d) => d.text.includes("FINAL_REPORT_READY")),
      "Final continuation result must reach original requester",
    ).toBe(true);
  });
});

async function delegated(expectsReply = true, hook?: (method: string) => Promise<void>) {
  const fixture = await running(hook);
  await runCauseEffect(fixture.store.getOrCreate("worker"));
  const sent = await callOpenBotTool(
    fixture.client,
    fixture.session.externalSessionId,
    "send_message",
    {
      recipientAgentIds: ["worker"],
      text: "Finish the approved report",
      expectsReply,
    },
    fixture.active.turnId,
  );
  expect(sent.error).toBeUndefined();
  await waitForQueue(fixture.service, "worker", (queue) => queue.deliveries[0]?.status === "running");
  const original = fixture.service.listQueue("worker").deliveries[0];
  const session = fixture.store.activeProviderSession("worker");
  if (!original?.turnId || !session) throw new Error("Missing delegated turn");
  const path = join(root, "user-data", "session-rollovers", createHash("sha256").update("worker").digest("hex"));
  const read = async () => JSON.parse(await readFile(path, "utf8"));
  const saved = await callOpenBotTool(
    fixture.client,
    session.externalSessionId,
    "session_checkpoint",
    { ...checkpoint, qualityBoundary: true },
    original.turnId,
  );
  expect(openBotToolPayload(saved.result).saved).toBe(true);
  return { ...fixture, original, workerTurnId: original.turnId, workerSession: session.externalSessionId, read };
}
function answer(client: FakeAgentClient, sessionId: string, turnId: string, text: string) {
  const item = { id: `answer-${turnId}`, type: "agentMessage", text, phase: "final_answer" };
  client.emit("notification", { method: "item/completed", params: { threadId: sessionId, turnId, item } });
}
async function rolloverWorker(fixture: Awaited<ReturnType<typeof delegated>>) {
  complete(fixture.client, fixture.workerSession, fixture.workerTurnId);
  await waitFor(async () => (await fixture.read()).phase === "accepted");
  const next = await fixture.read();
  expect(fixture.service.listQueue("worker").deliveries[0]?.status).toBe("running");
  expect(fixture.service.listQueue("worker").deliveries[0]?.turnId).toBe(next.continuationTurnId);
  return next;
}

describe.sequential("Rollover request ownership", () => {
  it.each([true, false])("relays one final result only for expectsReply=%s", async (expectsReply) => {
    const fixture = await delegated(expectsReply);
    answer(fixture.client, fixture.workerSession, fixture.workerTurnId, "INTERIM_ONLY");
    const next = await rolloverWorker(fixture);
    expect(
      fixture.service.listQueue("chief").deliveries.some((delivery) => delivery.text.includes("INTERIM_ONLY")),
    ).toBe(false);
    answer(fixture.client, next.newSessionId, next.continuationTurnId, "FINAL_REPORT_READY");
    complete(fixture.client, next.newSessionId, next.continuationTurnId);
    await waitForQueue(fixture.service, "worker", (queue) => queue.deliveries[0]?.status === "completed");
    complete(fixture.client, next.newSessionId, next.continuationTurnId);
    expect(
      fixture.service.listQueue("chief").deliveries.filter((delivery) => delivery.text.includes("FINAL_REPORT_READY")),
    ).toHaveLength(expectsReply ? 1 : 0);
  });

  it.each(["original", "continuation", "original-unlinked"])(
    "does not duplicate an explicit reply from the %s turn",
    async (when) => {
      const fixture = await delegated();
      async function reply(sessionId: string, turnId: string) {
        const result = await callOpenBotTool(
          fixture.client,
          sessionId,
          "send_message",
          {
            recipientAgentIds: ["chief"],
            text: "EXPLICIT_REPORT_READY",
            replyToMessageId: when === "original-unlinked" ? undefined : fixture.original.messageId,
            expectsReply: false,
          },
          turnId,
        );
        expect(result.error).toBeUndefined();
      }
      if (when !== "continuation") {
        await reply(fixture.workerSession, fixture.workerTurnId);
        // Reply is an action after checkpoint: refresh the checkpoint before the boundary.
        await callOpenBotTool(
          fixture.client,
          fixture.workerSession,
          "session_checkpoint",
          { ...checkpoint, qualityBoundary: true },
          fixture.workerTurnId,
        );
      }
      const next = await rolloverWorker(fixture);
      if (when === "continuation") await reply(next.newSessionId, next.continuationTurnId);
      answer(fixture.client, next.newSessionId, next.continuationTurnId, "FINAL_REPORT_READY");
      complete(fixture.client, next.newSessionId, next.continuationTurnId);
      await waitForQueue(fixture.service, "worker", (queue) => queue.deliveries[0]?.status === "completed");
      const replies = fixture.service.listQueue("chief").deliveries;
      expect(replies.filter((delivery) => delivery.text === "EXPLICIT_REPORT_READY")).toHaveLength(1);
      expect(replies.some((delivery) => delivery.text === "FINAL_REPORT_READY")).toBe(false);
    },
  );

  it.each(["Stop", "new input"])("preserves %s precedence over a later delegated boundary", async (action) => {
    const fixture = await delegated();
    const next = await rolloverWorker(fixture);
    await callOpenBotTool(
      fixture.client,
      next.newSessionId,
      "session_checkpoint",
      {
        ...checkpoint,
        qualityBoundary: true,
        completed: [...checkpoint.completed, { result: "Summary written", evidence: "runs/summary.md" }],
      },
      next.continuationTurnId,
    );
    if (action === "Stop") await runCauseEffect(fixture.service.interrupt("worker", next.continuationTurnId));
    else
      await runCauseEffect(
        fixture.service.sendMessage({ agentId: "worker", text: "Cancel the report; start the new local task" }),
      );
    complete(
      fixture.client,
      next.newSessionId,
      next.continuationTurnId,
      action === "Stop" ? "interrupted" : "completed",
    );
    await waitForQueue(
      fixture.service,
      "worker",
      (queue) =>
        queue.deliveries.find((delivery) => delivery.id === fixture.original.id)?.status ===
        (action === "Stop" ? "interrupted" : "completed"),
    );
    expect((await fixture.read()).phase).toBe("blocked");
    expect(fixture.client.requests.filter((request) => request.method === "thread/start")).toHaveLength(3);
    expect(
      fixture.service.listQueue("chief").deliveries.some((delivery) => delivery.text.includes("FINAL_REPORT_READY")),
    ).toBe(false);
  });

  it.each(["failure", "new input"])(
    "settles retained ownership after creation %s without sending an interim result",
    async (action) => {
      let creation = false;
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await delegated(true, async (method) => {
        if (!creation || method !== "thread/start") return;
        entered();
        await barrier;
        if (action === "failure") throw new Error("Owned synthetic creation failure");
      });
      creation = true;
      complete(fixture.client, fixture.workerSession, fixture.workerTurnId);
      await entering;
      expect(fixture.service.listQueue("worker").deliveries[0]?.status).toBe("running");
      if (action === "new input")
        await runCauseEffect(
          fixture.service.sendMessage({ agentId: "worker", text: "New local task supersedes the report" }),
        );
      release();
      await waitForQueue(
        fixture.service,
        "worker",
        (queue) =>
          queue.deliveries.find((delivery) => delivery.id === fixture.original.id)?.status ===
          (action === "failure" ? "failed" : "interrupted"),
      );
      expect(
        fixture.service.listQueue("chief").deliveries.some((delivery) => delivery.text.includes("FINAL_REPORT_READY")),
      ).toBe(false);
    },
  );

  it.each(["manual", "scheduled", "scheduled-quiet"])(
    "keeps a %s local routine run running until its final continuation settles",
    async (kind) => {
      let fixture = await startService(root, { autoComplete: false });
      service = fixture.service;
      await runCauseEffect(fixture.store.getOrCreate("worker"));
      await runCauseEffect(fixture.store.updatePreview("worker", "PREVIOUS_PREVIEW"));
      const routine = fixture.service.createRoutine({
        agentId: "worker",
        name: "Local report",
        instruction: "Finish the local report",
        active: true,
        timezone: "UTC",
        schedule: { kind: "daily", time: "09:00" },
      });
      const run =
        kind === "manual"
          ? await runCauseEffect(fixture.service.testRoutine({ agentId: "worker", routineId: routine.id }))
          : new AgentRoutineStore(fixture.store.database).createRun(
              routine,
              routine.trigger.id,
              "scheduled",
              "2026-10-14T08:00:00.000Z",
            );
      if (kind !== "manual") {
        await runCauseEffect(fixture.service.stop());
        service = null;
        fixture = await startService(root, { autoComplete: false });
        service = fixture.service;
      }
      await waitForQueue(fixture.service, "worker", (queue) => queue.deliveries[0]?.status === "running");
      const delivery = fixture.service.listQueue("worker").deliveries[0];
      const session = fixture.store.activeProviderSession("worker");
      if (!delivery?.turnId || !session) throw new Error("Missing routine turn");
      await callOpenBotTool(
        fixture.client,
        session.externalSessionId,
        "session_checkpoint",
        { ...checkpoint, qualityBoundary: true },
        delivery.turnId,
      );
      complete(fixture.client, session.externalSessionId, delivery.turnId);
      const path = join(root, "user-data", "session-rollovers", createHash("sha256").update("worker").digest("hex"));
      await waitFor(async () => JSON.parse(await readFile(path, "utf8")).phase === "accepted");
      const next = JSON.parse(await readFile(path, "utf8"));
      expect(fixture.service.listRoutineRuns({ agentId: "worker", routineId: routine.id, limit: 10 })[0]).toMatchObject(
        { id: run.id, status: "running" },
      );
      if (kind === "scheduled-quiet") {
        const quiet = await callOpenBotTool(
          fixture.client,
          next.newSessionId,
          "routine_no_update",
          {},
          next.continuationTurnId,
        );
        expect(quiet.error).toBeUndefined();
        expect(openBotToolPayload(quiet.result).status).toBe("quiet");
      } else answer(fixture.client, next.newSessionId, next.continuationTurnId, "ROUTINE_FINAL_READY");
      complete(fixture.client, next.newSessionId, next.continuationTurnId);
      await waitFor(() => !fixture.service.getRuntimeSnapshot().activeTurns.some((turn) => turn.agentId === "worker"));
      await writeFile(
        join(process.cwd(), ".openbot-build", "rollover", "repair-routine.json"),
        JSON.stringify(
          {
            queue: fixture.service.listQueue("worker"),
            runs: fixture.service.listRoutineRuns({ agentId: "worker", routineId: routine.id, limit: 10 }),
            journal: JSON.parse(await readFile(path, "utf8")),
          },
          null,
          2,
        ),
      );
      await waitFor(
        () =>
          fixture.service.listRoutineRuns({ agentId: "worker", routineId: routine.id, limit: 10 })[0]?.status ===
          "succeeded",
      );
      expect(fixture.service.listRoutineRuns({ agentId: "worker", routineId: routine.id, limit: 10 })).toHaveLength(1);
      if (kind === "scheduled-quiet")
        expect(fixture.service.listAgents().find((agent) => agent.id === "worker")?.preview).toBe("PREVIOUS_PREVIEW");
    },
  );
});

class DelayedRolloverResponse extends FakeAgentClient {
  constructor(
    readonly releaseResponse: Promise<void>,
    readonly entered: () => void,
  ) {
    super("codex", undefined, false);
  }
  override request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>) {
    const response = super.request(method, params, decoder);
    if (method !== "turn/start" || !getString(params, "clientUserMessageId")?.startsWith("session-rollover:"))
      return response;
    return response.pipe(
      Effect.tap(() =>
        Effect.promise(async () => {
          this.entered();
          await this.releaseResponse;
        }),
      ),
    );
  }
}
describe.sequential("Provider lifecycle before rollover response", () => {
  it.each([false, true])(
    "settles an early terminal event without overwriting a newer checkpoint=%s",
    async (saveAgain) => {
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chosen = new DelayedRolloverResponse(barrier, () => entered());
      const fixture = await running(undefined, chosen);
      await save(fixture, { ...checkpoint, qualityBoundary: true });
      complete(chosen, fixture.session.externalSessionId, fixture.active.turnId);
      await entering;
      try {
        await waitFor(() =>
          fixture.service
            .getRuntimeSnapshot()
            .activeTurns.some((turn) => turn.agentId === "chief" && turn.turnId !== fixture.active.turnId),
        );
        const turn = fixture.service.getRuntimeSnapshot().activeTurns.find((turn) => turn.agentId === "chief");
        const session = fixture.store.activeProviderSession("chief");
        if (!turn || !session) throw new Error("Missing accepted provider writer");
        if (saveAgain) {
          const saved = await callOpenBotTool(
            chosen,
            session.externalSessionId,
            "session_checkpoint",
            { ...checkpoint, status: "done" },
            turn.turnId,
          );
          expect(openBotToolPayload(saved.result).saved).toBe(true);
        }
        complete(chosen, session.externalSessionId, turn.turnId);
        release();
        await waitForQueue(fixture.service, "chief", (queue) => queue.deliveries[0]?.status === "completed");
        expect((await journal()).phase).toBe("blocked");
        if (saveAgain)
          expect(await journal()).toMatchObject({ automatic: true, hops: 1, checkpoint: { status: "done" } });
        await runCauseEffect(fixture.service.stop());
        service = null;
        const restarted = await startService(root, { autoComplete: false });
        service = restarted.service;
        expect((await journal()).phase).toBe("blocked");
      } finally {
        release();
      }
    },
  );
});
