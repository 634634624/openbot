import type { AgentSummary } from "@openbot/contracts/ipc";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Semaphore } from "effect";
import { z } from "zod";
import type { AgentStore } from "../agent-store";
import type { MailboxStore } from "../mailbox-store";
import { createAgentToolSchema } from "./profile-tools";
import type { MailboxSync } from "./mailbox-sync";
import type { ConversationRuntime } from "./conversation-runtime";

const boundedBrief = z.string().trim().min(1).max(20_000);
export const spawnHelperToolSchema = z.object({
  name: createAgentToolSchema.shape.name,
  role: z.string().trim().min(1).max(INPUT_LIMITS.agentTitle),
  personality: z.string().trim().max(1000).optional(),
  claim: boundedBrief,
  acceptance: boundedBrief,
  scope: boundedBrief,
  provider: createAgentToolSchema.shape.provider,
  model: createAgentToolSchema.shape.model,
  reasoningEffort: createAgentToolSchema.shape.reasoningEffort,
}).strict();
export type SpawnHelperInput = z.infer<typeof spawnHelperToolSchema>;

export function helperBrief(input: SpawnHelperInput): string {
  return JSON.stringify({ claim: input.claim, acceptance: input.acceptance, scope: input.scope });
}

export function helperActive(helper: NonNullable<AgentSummary["helper"]>): boolean {
  return helper.status === "queued" || helper.status === "running";
}

const helperStatusKeys = { queued: "agent.helper.queued", running: "agent.helper.running",
  completed: "agent.helper.completed", failed: "agent.helper.failed", cancelled: "agent.helper.cancelled" } as const;

/** Owns durable job outcomes and idempotent result delivery; never deletes a workspace. */
export class HelperJobs {
  readonly #settlements = Semaphore.makeUnsafe(1);
  constructor(
    private readonly store: AgentStore,
    private readonly mailbox: MailboxStore,
    private readonly sync: MailboxSync,
    private readonly conversation: ConversationRuntime,
    private readonly changed: () => void,
    private readonly schedule: (id: string) => void,
    private readonly redact: (text: string) => string,
  ) {}

  publish(id: string): void {
    const agent = this.store.list().find((entry) => entry.id === id);
    const helper = agent?.helper;
    if (!agent || !helper) return;
    this.conversation.upsertHelperItem(helper.parentAgentId, helper.parentThreadId, {
      id: `helper-job:${helper.jobId}`, author: "system", source: "system",
      status: "completed", createdAt: helper.createdAt, itemType: "helper-job",
      text: this.redact(sourceText("agent.helper.record", {
        parent: helper.parentAgentName, helper: agent.name, role: helper.role,
        status: sourceText(helperStatusKeys[helper.status]), result: helper.result,
      })),
    });
  }

  readonly started = Effect.fn("HelperJobs.started")(function* (this: HelperJobs, id: string) {
    const helper = this.store.list().find((agent) => agent.id === id)?.helper;
    if (!helper || !helperActive(helper)) return;
    yield* this.store.setHelperJob(id, { ...helper, status: "running" });
    this.publish(id);
    this.changed();
  });

  settle(id: string, status: "completed" | "failed" | "cancelled", text: string) {
    return this.#settlements.withPermit(this.#settle(id, status, text));
  }

  readonly #settle = Effect.fn("HelperJobs.settle")(function* (
    this: HelperJobs, id: string, status: "completed" | "failed" | "cancelled", text: string,
  ) {
    let agent = this.store.list().find((entry) => entry.id === id);
    if (!agent?.helper) return;
    if (helperActive(agent.helper)) {
      const result = this.redact(text).slice(0, INPUT_LIMITS.messageText - 1000);
      agent = yield* this.store.setHelperJob(id, {
        ...agent.helper, status: agent.helper.cancelRequested ? "cancelled" : status, result, completedAt: new Date().toISOString(),
      });
    }
    this.publish(id);
    yield* this.result(agent);
    this.changed();
  });

  private readonly result = Effect.fn("HelperJobs.result")(function* (this: HelperJobs, agent: AgentSummary) {
    const helper = agent.helper;
    if (!helper || helperActive(helper) || helper.resultMessageId) return;
    if (!this.store.list().some((entry) => entry.id === helper.parentAgentId)) return;
    const receipt = yield* this.mailbox.enqueue({
      sender: { kind: "agent", agentId: agent.id },
      recipientAgentIds: [helper.parentAgentId],
      text: this.redact(`Helper ${agent.name} (${helper.role}): ${helper.status}\nOrigin thread: ${helper.parentThreadId}\n${helper.result}`),
      replyToMessageId: helper.originMessageId,
      expectsReply: false,
      idempotencyKey: `helper-result:${helper.jobId}`,
    });
    yield* this.store.setHelperJob(agent.id, { ...helper, resultMessageId: receipt.messageId });
    const parent = this.store.list().find((entry) => entry.id === helper.parentAgentId);
    if (parent) {
      const snapshot = this.conversation.ensureSnapshot(parent.id, parent.threadId);
      this.sync.syncMailboxMessages(snapshot);
      this.conversation.emitConversation(snapshot);
    }
    this.sync.emitQueue(helper.parentAgentId);
    this.schedule(helper.parentAgentId);
  });

  readonly recover = Effect.fn("HelperJobs.recover")(function* (this: HelperJobs) {
    for (const agent of this.store.list()) {
      if (!agent.helper) continue;
      this.mailbox.blockAgentDeliveries(agent.id);
      if (helperActive(agent.helper)) {
        for (const id of this.mailbox.queuedDeliveryIds(agent.id)) yield* this.mailbox.cancel(agent.id, id);
        yield* this.settle(agent.id, "failed", sourceText("error.agent.helperRestarted"));
      } else {
        this.publish(agent.id);
        yield* this.result(agent);
      }
    }
    this.changed();
  });
}
