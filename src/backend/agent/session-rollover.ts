import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Schema } from "effect";
import { z } from "zod";
import type { AgentStore } from "../agent-store";
import { causeHelpers } from "../effect-boundary";
import type { DeliveryContext, MailboxStore } from "../mailbox-store";
import { decodeTurnResponse } from "../protocol";
import type { ContextCompaction } from "./context-compaction";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MemoryHold } from "./memory-hold";
import type { ProviderRuntime } from "./provider-runtime";
import { checkpointHandoff, sessionCheckpointSchema } from "./session-checkpoint";
import { sessionSettingsOverrides } from "./session-settings";
import { isRequestTimeout } from "./thread-items";
import type { ThreadLifecycle } from "./thread-lifecycle";
import { codexSandboxPolicy, workspaceWritableRoots } from "./workspace-sandbox";

// Local policy: a genuine input allows at most eight fresh contexts, with new completed evidence at each later boundary.
const MAX_AUTOMATIC_HOPS = 8;
const progressKeys = (checkpoint: z.infer<typeof sessionCheckpointSchema>) =>
  checkpoint.completed.map((item) => item.result.trim().replace(/\s+/gu, " ").toLowerCase());

const journalSchema = z.strictObject({
  version: z.literal(1),
  id: z.string(),
  agentId: z.string(),
  publicThreadId: z.string(),
  oldSessionId: z.string(),
  turnId: z.string(),
  phase: z.enum(["checkpoint", "ready", "prepared", "starting", "accepted", "held", "blocked"]),
  newSessionId: z.string().nullable(),
  checkpoint: sessionCheckpointSchema,
  automatic: z.boolean(),
  inputFingerprint: z.string(),
  continuationTurnId: z.string().nullable(),
  hops: z.number().int().min(0).max(8).default(0),
  progressBaseline: z.array(z.string()).max(12).default([]),
  deliveryIds: z.array(z.string()).default([]),
  ownerTurnIds: z.array(z.string()).max(9).default([]),
});
type Journal = z.infer<typeof journalSchema>;

export interface SessionRolloverOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  compaction: ContextCompaction;
  threads: ThreadLifecycle;
  providers: ProviderRuntime;
  memory: MemoryHold;
  settleDeliveries(
    agentId: string,
    deliveries: readonly DeliveryContext[],
    status: "interrupted" | "failed",
  ): Effect.Effect<void, SessionRolloverFailed>;
  redact(text: string): string;
  emitError(code: string, error: unknown, agentId: string): void;
}

/** Owns the bounded persisted checkpoint and single-attempt fresh-session continuation. */
export class SessionRollover {
  readonly #options: SessionRolloverOptions;
  readonly #automaticTurns = new Set<string>();
  readonly #pendingStarts = new Map<string, Deferred.Deferred<void>>();
  readonly #cancelled = new Set<string>();
  readonly #uncertain = new Set<string>();
  readonly #recoveryHolds = new Map<string, string>();
  readonly #invalidatedTurns = new Set<string>();

  actedAfterCheckpoint(turnId: string): void {
    this.#invalidatedTurns.add(turnId);
  }

  mayDrain(agentId: string): boolean {
    return !this.#uncertain.has(agentId);
  }

  observedTurn(agentId: string, sessionId: string): void {
    const expected = this.#recoveryHolds.get(agentId);
    if (expected && expected !== sessionId) return;
    this.#uncertain.delete(agentId);
  }

  #fingerprint(agentId: string): string {
    const messages = this.#options.conversation.workingSnapshot(agentId)?.messages ?? [];
    return createHash("sha256")
      .update(
        JSON.stringify(
          messages
            .filter((message) => message.author !== "assistant")
            .map(({ id, text, source, replyToMessageId, attachments }) => ({
              id,
              text,
              source,
              replyToMessageId,
              attachments,
            })),
        ),
      )
      .digest("hex");
  }

  constructor(options: SessionRolloverOptions) {
    this.#options = options;
  }

  /** Load durable uncertainty before providers or queued deliveries can start. Never replay a crashed request. */
  readonly recover = Effect.fn("SessionRollover.recover")(function* (this: SessionRollover) {
    for (const agent of this.#options.store.list()) {
      const journal = yield* this.#read(agent.id);
      if (!journal || journal.phase === "blocked" || !agent.threadId || agent.helper) continue;
      const session = this.#options.store.database.activeProviderSession(agent.threadId, agent.provider);
      const expected = journal.newSessionId ?? journal.oldSessionId;
      if (agent.threadId !== journal.publicThreadId || session?.externalSessionId !== expected) continue;
      // A pre-crash checkpoint may have been followed by tools or a Stop whose transient flags died.
      // Retain its state for recovery, but never automatically dispatch from that stale checkpoint.
      yield* this.#write({ ...journal, phase: "held" });
      this.#options.conversation.bindThread(expected, agent.id, journal.publicThreadId);
      this.#recoveryHolds.set(agent.id, expected);
      this.#uncertain.add(agent.id);
      this.#options.emitError(
        "session_rollover_recovery_hold",
        new Error(
          "Recovered unfinished rollover; queued dispatch is held until the bound provider reports its turn lifecycle. No automatic replay.",
        ),
        agent.id,
      );
    }
  });

  #path(agentId: string): string {
    return join(
      this.#options.store.database.userDataPath,
      "session-rollovers",
      createHash("sha256").update(agentId).digest("hex"),
    );
  }

  readonly #read = Effect.fn("SessionRollover.read")(function* (this: SessionRollover, agentId: string) {
    return yield* io(async () => {
      let content: string;
      try {
        content = await readFile(this.#path(agentId), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      if (content.length > 16_000) throw new Error("Rollover journal exceeds its bound.");
      return journalSchema.parse(JSON.parse(content));
    });
  });

  readonly #write = Effect.fn("SessionRollover.write")(function* (this: SessionRollover, journal: Journal) {
    yield* io(async () => {
      const directory = join(this.#options.store.database.userDataPath, "session-rollovers");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = this.#path(journal.agentId);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
      await rename(temporary, path);
    });
  });

  cancel(agentId: string): void {
    this.#cancelled.add(agentId);
  }

  readonly save = Effect.fn("SessionRollover.save")(function* (
    this: SessionRollover,
    agentId: string,
    sessionId: string,
    turnId: string,
    input: unknown,
  ) {
    const { store, conversation, redact } = this.#options;
    const agent = store.list().find((item) => item.id === agentId);
    const snapshot = conversation.workingSnapshot(agentId);
    const session = agent?.threadId ? store.database.activeProviderSession(agent.threadId, agent.provider) : null;
    if (
      !agent ||
      agent.helper ||
      !snapshot?.threadId ||
      snapshot.activeTurnId !== turnId ||
      session?.externalSessionId !== sessionId
    )
      return yield* new SessionRolloverFailed({
        cause: new Error(
          !agent || agent.helper
            ? "Checkpoint requires a personal agent."
            : !snapshot?.threadId
              ? "Checkpoint has no active personal snapshot."
              : snapshot.activeTurnId !== turnId
                ? "Checkpoint belongs to a different turn."
                : "Checkpoint belongs to a different provider session.",
        ),
      });
    const previous = yield* this.#read(agentId);
    const automatic =
      this.#automaticTurns.has(turnId) ||
      (previous?.newSessionId === sessionId &&
        (previous.continuationTurnId === turnId || previous.phase === "starting")) ||
      (previous?.automatic === true && previous.oldSessionId === sessionId && previous.turnId === turnId);
    const parsed = yield* io(async () => sessionCheckpointSchema.parse(JSON.parse(redact(JSON.stringify(input)))));
    // Keep earlier constraints/evidence even if the model's later summary omits them.
    const checkpoint = yield* io(async () =>
      sessionCheckpointSchema.parse(
        automatic && previous
          ? {
              ...parsed,
              constraints: [...new Set([...previous.checkpoint.constraints, ...parsed.constraints])],
              authority: [...new Set([...previous.checkpoint.authority, ...parsed.authority])],
              completed: [
                ...previous.checkpoint.completed,
                ...parsed.completed.filter(
                  (item) =>
                    !progressKeys(previous.checkpoint).includes(item.result.trim().replace(/\s+/gu, " ").toLowerCase()),
                ),
              ],
            }
          : parsed,
      ),
    );
    yield* this.#write({
      version: 1,
      id: randomUUID(),
      agentId,
      publicThreadId: snapshot.threadId,
      oldSessionId: sessionId,
      turnId,
      phase: "checkpoint",
      newSessionId: null,
      checkpoint,
      automatic,
      hops: automatic ? (previous?.hops ?? 0) + (previous?.phase === "starting" ? 1 : 0) : 0,
      progressBaseline:
        automatic && previous
          ? previous.turnId === turnId && previous.oldSessionId === sessionId
            ? previous.progressBaseline
            : progressKeys(previous.checkpoint)
          : [],
      inputFingerprint: this.#fingerprint(agentId),
      continuationTurnId: null,
      deliveryIds: this.#options.mailbox.findDeliveriesByTurn(agentId, turnId).map(({ delivery }) => delivery.id),
      ownerTurnIds: automatic && previous ? [...new Set([...previous.ownerTurnIds, turnId])] : [turnId],
    });
    this.#invalidatedTurns.delete(turnId);
    return {
      saved: true,
      continuation: "Only after this turn completes at a safe boundary; no new authority granted.",
    };
  });

  /** Called after tools, images and delivery writes settle, before the drain is released. */
  readonly finishTurn = Effect.fn("SessionRollover.finishTurn")(function* (
    this: SessionRollover,
    agentId: string,
    sessionId: string,
    turnId: string,
    status: string,
  ) {
    const pendingStart = this.#pendingStarts.get(agentId);
    if (pendingStart) yield* Deferred.await(pendingStart);
    this.observedTurn(agentId, sessionId);
    this.#recoveryHolds.delete(agentId);
    const invalidated = this.#invalidatedTurns.delete(turnId);
    const cancelled = this.#cancelled.delete(agentId);
    this.#automaticTurns.delete(turnId);
    const journal = yield* this.#read(agentId);
    if (journal?.phase === "held" && (journal.newSessionId ?? journal.oldSessionId) === sessionId) {
      yield* this.#write({ ...journal, phase: "blocked" });
      return false;
    }
    if (
      journal &&
      ["accepted", "starting"].includes(journal.phase) &&
      journal.newSessionId === sessionId &&
      (journal.continuationTurnId === turnId || (journal.phase === "starting" && journal.continuationTurnId === null))
    ) {
      yield* this.#write({ ...journal, phase: "blocked", continuationTurnId: turnId });
      return false;
    }
    if (!journal || journal.turnId !== turnId || journal.oldSessionId !== sessionId || journal.phase !== "checkpoint")
      return false;
    const { store, providers, compaction } = this.#options;
    const agent = store.list().find((item) => item.id === agentId);
    const mode = agent ? providers.clientForAgent(agent)?.contextCompaction : "unsupported";
    const supported = mode === "events" || mode === "request" || mode === "native";
    const eligible =
      !cancelled &&
      !invalidated &&
      status === "completed" &&
      journal.hops < MAX_AUTOMATIC_HOPS &&
      (!journal.automatic || progressKeys(journal.checkpoint).some((key) => !journal.progressBaseline.includes(key))) &&
      journal.inputFingerprint === this.#fingerprint(agentId) &&
      journal.checkpoint.status === "open" &&
      supported &&
      (journal.checkpoint.qualityBoundary || compaction.rolloverPressure(sessionId));
    yield* this.#write({ ...journal, phase: eligible ? "ready" : "blocked" });
    return eligible;
  });

  /** Explicit results in earlier segments suppress an automatic result for the same request. */
  readonly hasExplicitResult = Effect.fn("SessionRollover.hasExplicitResult")(function* (
    this: SessionRollover,
    agentId: string,
    turnId: string,
    recipientAgentId: string,
  ) {
    const journal = yield* this.#read(agentId);
    if (!journal?.ownerTurnIds.includes(turnId)) return false;
    return journal.ownerTurnIds.some((owner) =>
      this.#options.mailbox.hasAgentMessageFromTurnTo(agentId, owner, recipientAgentId),
    );
  });

  /** The provider start event associates retained requests before completion can settle them. */
  readonly associateTurn = Effect.fn("SessionRollover.associateTurn")(function* (
    this: SessionRollover,
    agentId: string,
    sessionId: string,
    turnId: string,
  ) {
    if (
      !this.#pendingStarts.has(agentId) &&
      !this.#automaticTurns.has(turnId) &&
      this.#recoveryHolds.get(agentId) !== sessionId
    )
      return;
    const journal = yield* this.#read(agentId);
    if (!journal || journal.newSessionId !== sessionId || !["starting", "accepted", "held"].includes(journal.phase))
      return;
    if (journal.continuationTurnId && journal.continuationTurnId !== turnId) return;
    for (const id of journal.deliveryIds) {
      const context = this.#options.mailbox.getDelivery(id);
      if (context?.delivery.recipientAgentId === agentId && ["running", "starting"].includes(context.delivery.status))
        yield* this.#options.mailbox.markRunning(id, turnId).pipe(toRolloverFailed);
    }
  });

  readonly #abandon = Effect.fn("SessionRollover.abandon")(function* (
    this: SessionRollover,
    journal: Journal,
    status: "interrupted" | "failed",
  ) {
    const deliveries = this.#options.mailbox
      .findDeliveriesByTurn(journal.agentId, journal.turnId)
      .filter(({ delivery }) => journal.deliveryIds.includes(delivery.id));
    yield* this.#options.settleDeliveries(journal.agentId, deliveries, status);
    yield* this.#write({ ...journal, phase: "blocked" });
  });

  /** Runs inside the existing per-agent drain lock. Genuine messages always take priority. */
  readonly drain = Effect.fn("SessionRollover.drain")(function* (this: SessionRollover, agentId: string) {
    const options = this.#options;
    const journal = yield* this.#read(agentId);
    if (!journal || !["ready", "prepared"].includes(journal.phase)) return false;
    const agent = options.store.list().find((item) => item.id === agentId);
    if (!agent || agent.helper || agent.threadId !== journal.publicThreadId) return false;
    const session = options.store.database.activeProviderSession(journal.publicThreadId, agent.provider);
    const expectedSession = journal.newSessionId ?? journal.oldSessionId;
    if (session?.externalSessionId !== expectedSession || options.conversation.workingSnapshot(agentId)?.activeTurnId)
      return false;
    if (this.#cancelled.has(agentId)) {
      yield* this.#abandon(journal, "interrupted");
      return false;
    }
    const client = yield* options.providers.ensureAgentClient(agent).pipe(toRolloverFailed);
    let prepared = journal;
    if (journal.phase === "ready") {
      yield* this.#write({ ...journal, phase: "blocked" });
      const newSessionId = yield* options.threads
        .rolloverThread(agent, client, journal.oldSessionId, checkpointHandoff(journal.checkpoint))
        .pipe(toRolloverFailed);
      prepared = { ...journal, phase: "prepared", newSessionId };
      yield* this.#write(prepared);
    }
    // Thread creation can await. A new message or stop now supersedes automatic continuation.
    if (options.mailbox.queuedDeliveryIds(agentId).length > 0 || this.#cancelled.has(agentId)) {
      yield* this.#abandon(prepared, "interrupted");
      return false;
    }
    const current = options.store.list().find((item) => item.id === agentId);
    if (
      !current ||
      current.provider !== agent.provider ||
      current.model !== agent.model ||
      current.reasoningEffort !== agent.reasoningEffort ||
      options.threads.runtimeRefreshPending(agentId)
    ) {
      yield* this.#abandon(prepared, "interrupted");
      return false;
    }
    const threadId = prepared.newSessionId;
    if (!threadId)
      return yield* new SessionRolloverFailed({ cause: new Error("Prepared rollover has no provider session.") });
    const handoff = options.threads.consumePendingHandoff(threadId);
    if (!handoff)
      return yield* new SessionRolloverFailed({
        cause: new Error("Fresh session is missing its persisted checkpoint."),
      });
    // Write before turn/start. After a crash/uncertain request this is never automatically replayed.
    yield* this.#write({ ...prepared, phase: "starting" });
    if (options.mailbox.queuedDeliveryIds(agentId).length > 0 || this.#cancelled.has(agentId)) {
      yield* this.#abandon(prepared, "interrupted");
      return false;
    }
    const release = options.memory.reserveTurn();
    const releaseRefresh = options.threads.holdRuntimeRefresh(agentId);
    let accepted = false;
    let uncertain = false;
    const pendingStart = Deferred.makeUnsafe<void>();
    this.#pendingStarts.set(agentId, pendingStart);
    this.#uncertain.add(agentId);
    yield* Effect.gen({ self: this }, function* () {
      const response = yield* client
        .request(
          "turn/start",
          {
            threadId,
            model: agent.model,
            effort: agent.reasoningEffort,
            sessionSettings: sessionSettingsOverrides(
              options.store.list().find((item) => item.id === agentId) ?? agent,
            ),
            clientUserMessageId: `session-rollover:${journal.id}`,
            input: [
              {
                type: "text",
                text: `${handoff}\nAutomatic rollover ${prepared.hops + 1}/${MAX_AUTOMATIC_HOPS}; later boundaries require additional completed progress with evidence. Continue the authorized next action from this checkpoint. Do not send a rollover announcement.`,
              },
            ],
            cwd: agent.workspacePath,
            runtimeWorkspaceRoots: workspaceWritableRoots(agent, options.store.sharedRoot),
            approvalPolicy: "on-request",
            sandboxPolicy: codexSandboxPolicy(agent, options.store.sharedRoot),
          },
          decodeTurnResponse,
        )
        .pipe(
          toRolloverFailed,
          Effect.tapError((failure) =>
            Effect.sync(() => {
              uncertain = isRequestTimeout(failure.cause, "turn/start");
            }),
          ),
        );
      accepted = true;
      this.#automaticTurns.add(response.turn.id);
      options.conversation.ensureSnapshot(agentId, journal.publicThreadId).activeTurnId = response.turn.id;
      for (const { delivery } of options.mailbox.findDeliveriesByTurn(agentId, prepared.turnId)) {
        if (prepared.deliveryIds.includes(delivery.id))
          yield* options.mailbox.markRunning(delivery.id, response.turn.id).pipe(toRolloverFailed);
      }
      const latest = yield* this.#read(agentId);
      if (!(latest?.phase === "checkpoint" && latest.oldSessionId === threadId && latest.turnId === response.turn.id))
        yield* this.#write({
          ...prepared,
          phase: "accepted",
          hops: prepared.hops + 1,
          continuationTurnId: response.turn.id,
          ownerTurnIds: [...new Set([...prepared.ownerTurnIds, response.turn.id])],
        });
      this.#uncertain.delete(agentId);
      yield* options.threads.deletePendingHandoff(threadId).pipe(toRolloverFailed);
    }).pipe(
      Effect.ensuring(
        Effect.gen({ self: this }, function* () {
          this.#pendingStarts.delete(agentId);
          yield* Deferred.succeed(pendingStart, undefined);
          releaseRefresh();
          if (!accepted && !uncertain) {
            this.#uncertain.delete(agentId);
            release();
          }
        }),
      ),
    );
    return true;
  }, Effect.uninterruptible);

  /** One failed attempt leaves recoverable state and never reschedules itself. */
  readonly attempt = Effect.fn("SessionRollover.attempt")(function* (this: SessionRollover, agentId: string) {
    return yield* this.drain(agentId).pipe(
      Effect.catch((failure) =>
        Effect.gen({ self: this }, function* () {
          this.#options.emitError("session_rollover_failed", failure.cause, agentId);
          const journal = yield* this.#read(agentId);
          if (
            journal &&
            !this.#uncertain.has(agentId) &&
            ["ready", "blocked", "prepared", "starting"].includes(journal.phase)
          )
            yield* this.#abandon(journal, "failed");
          return false;
        }),
      ),
      Effect.catch((failure) =>
        Effect.gen({ self: this }, function* () {
          this.#uncertain.add(agentId);
          this.#options.emitError("session_rollover_failed", failure.cause, agentId);
          const journal = yield* this.#read(agentId);
          if (journal) yield* this.#write({ ...journal, phase: "held" });
          return false;
        }).pipe(Effect.catch(() => Effect.succeed(false))),
      ),
    );
  });
}

export class SessionRolloverFailed extends Schema.TaggedError<SessionRolloverFailed>()("SessionRolloverFailed", {
  cause: Schema.Defect(),
}) {}
const { rewrap: toRolloverFailed } = causeHelpers(SessionRolloverFailed);
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new SessionRolloverFailed({ cause }) });
