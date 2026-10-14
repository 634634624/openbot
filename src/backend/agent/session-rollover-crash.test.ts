// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RequestTimeoutError } from "../agent-client";
import {
  callOpenBotTool,
  FakeAgentClient,
  openBotToolPayload,
  startService,
  waitFor,
} from "../agent-service-test-harness";
import { runCauseEffect } from "../effect-boundary";

// A subprocess-only crash fixture. No graceful service shutdown: exercise persisted state, not a new class instance.
it.skipIf(!process.env.OPENBOT_ROLLOVER_CRASH_ROOT)(
  "crashes exactly at the requested durable boundary",
  async () => {
    const root = process.env.OPENBOT_ROLLOVER_CRASH_ROOT;
    const phase = process.env.OPENBOT_ROLLOVER_CRASH_PHASE;
    if (!root || !phase) throw new Error("Missing explicit crash fixture boundary");
    let failStart = false;
    const client = new FakeAgentClient("codex", undefined, false, true, {}, async (method) => {
      if (failStart && method === "turn/start") throw new RequestTimeoutError("Codex", "turn/start");
    });
    const fixture = await startService(root, {
      autoComplete: false,
      client: (provider) => (provider === "codex" ? client : new FakeAgentClient(provider, undefined, false)),
    });
    await runCauseEffect(
      fixture.service.sendMessage({ agentId: "chief", text: "Local crash fixture, no external action" }),
    );
    await waitFor(() => fixture.service.getRuntimeSnapshot().activeTurns.length === 1);
    const active = fixture.service.getRuntimeSnapshot().activeTurns[0];
    const session = fixture.store.activeProviderSession("chief");
    if (!active || !session) throw new Error("Crash fixture has no active writer");
    const result = await callOpenBotTool(
      client,
      session.externalSessionId,
      "session_checkpoint",
      {
        status: "open",
        goal: "Local crash fixture",
        constraints: ["No external action"],
        authority: ["Local fixture only"],
        decisions: [],
        completed: [],
        pending: [{ request: "Continue local fixture", owner: "chief" }],
        paths: [],
        nextAction: "Continue local fixture",
        qualityBoundary: true,
      },
      active.turnId,
    );
    expect(openBotToolPayload(result.result).saved).toBe(true);
    const path = join(root, "user-data", "session-rollovers", createHash("sha256").update("chief").digest("hex"));
    if (phase === "starting") {
      failStart = true;
      client.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: session.externalSessionId,
          turn: { id: active.turnId, status: "completed" },
        },
      });
      await waitFor(async () => JSON.parse(await readFile(path, "utf8")).phase === "starting");
    }
    expect(JSON.parse(await readFile(path, "utf8")).phase).toBe(phase);
    await writeFile(join(root, "crash-receipt.json"), JSON.stringify({ pid: process.pid, phase }));
    process.kill(process.pid, "SIGKILL");
  },
  30_000,
);
