// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import { callOpenBotTool, openBotToolPayload, startAgentTestFixture, startService, stopAgentTestFixture, waitFor } from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import { getString } from "./protocol";

let root: string;
let service: AgentService | null = null;
beforeEach(async () => { ({ root } = await startAgentTestFixture()); });
afterEach(async () => { await stopAgentTestFixture(root, service); service = null; });

describe.sequential("independent temporary helper acceptance", () => {
  it("allows the origin to dispatch one explicit helper brief", async () => {
    const started = await startService(root, { provider: "codex", autoComplete: false, allowTemporaryHelpers: true });
    service = started.service;
    await runCauseEffect(started.store.getOrCreate("origin"));
    await runCauseEffect(service.sendMessage({ agentId: "origin", text: "PARENT_CHAT_SENTINEL_82a" }));
    await waitFor(() => started.client.requests.some((entry) => entry.method === "turn/start"));
    const turn = started.client.requests.find((entry) => entry.method === "turn/start");
    const threadId = getString(turn?.params, "threadId");
    expect(threadId).toBeTruthy();
    const result = await callOpenBotTool(started.client, threadId!, "spawn_helper", {
      name: "Independent verifier", role: "Verifier", claim: "The fixture preserves one result", acceptance: "Return inspected evidence", scope: "Read only synthetic fixture", provider: "codex", model: "gpt-6-luna",
    });
    expect(result.error).toBeUndefined();
    const payload = openBotToolPayload(result.result);
    expect(payload.error).toBeUndefined();
    expect(payload).toHaveProperty("helper");
    const helper = service.listAgents().find((agent) => agent.helper?.parentAgentId === "origin");
    expect(helper?.helper?.claim).toBe("The fixture preserves one result");
    expect(helper?.description).not.toContain("PARENT_CHAT_SENTINEL_82a");
    expect(helper?.helper).not.toHaveProperty("history");
    await waitFor(() => started.client.requests.some((entry) => entry.method === "turn/start" && getString(entry.params, "cwd") === helper?.workspacePath));
    const helperTurn = started.client.requests.find((entry) => entry.method === "turn/start" && getString(entry.params, "cwd") === helper?.workspacePath);
    expect(helperTurn?.params).toMatchObject({ answerOptional: false });
    expect(JSON.stringify(helperTurn?.params)).not.toContain("PARENT_CHAT_SENTINEL_82a");
    expect(helper?.allowAutomation).toBe(false);
    expect(helper?.notifications).toBe(false);
    await expect(runCauseEffect(service.sendMessage({ agentId: helper!.id, text: "another job" }))).rejects.toThrow();
    await expect(runCauseEffect(service.duplicateAgent(helper!.id))).rejects.toThrow();
  });
  it("deduplicates concurrent spawn retries and rejects nested helpers", async () => {
    const started = await startService(root, { provider: "codex", autoComplete: false, allowTemporaryHelpers: true });
    service = started.service;
    await runCauseEffect(started.store.getOrCreate("origin"));
    await runCauseEffect(service.sendMessage({ agentId: "origin", text: "Start the review" }));
    await waitFor(() => started.client.requests.some((entry) => entry.method === "turn/start"));
    const parent = service.listAgents().find((agent) => agent.id === "origin")!;
    const brief = { name: "Reviewer", role: "Reviewer", claim: "Inspect the fixture",
      acceptance: "Return evidence", scope: "Read the fixture only", provider: "codex" as const, model: "gpt-6-luna" };
    const [first, second] = await Promise.all([
      runCauseEffect(service.spawnHelper(parent.id, parent.threadId!, "retry-key", brief)),
      runCauseEffect(service.spawnHelper(parent.id, parent.threadId!, "retry-key", brief)),
    ]);
    expect(second.id).toBe(first.id);
    expect(service.listAgents().filter((agent) => agent.helper)).toHaveLength(1);
    await expect(runCauseEffect(service.spawnHelper(first.id, first.threadId!, "nested", brief))).rejects.toThrow();
    await expect(runCauseEffect(service.cancelHelper("not-the-parent", first.helper!.jobId))).rejects.toThrow();
    await runCauseEffect(service.cancelHelper(parent.id, first.helper!.jobId));
    expect(service.listAgents().find((agent) => agent.id === first.id)?.helper?.cancelRequested).toBe(true);
  });

});
