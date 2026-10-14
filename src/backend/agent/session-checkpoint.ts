import { z } from "zod";

const text = z.string().trim().min(1).max(1200);
const entries = z.array(text).max(12);

/** Provider-facing boundary. A checkpoint records state, never grants execution authority. */
export const sessionCheckpointSchema = z
  .strictObject({
    status: z.enum(["open", "done", "cancelled", "waiting"]),
    goal: text,
    constraints: entries,
    authority: entries,
    decisions: entries,
    completed: z.array(z.strictObject({ result: text, evidence: text })).max(12),
    pending: z.array(z.strictObject({ request: text, owner: text })).max(12),
    paths: entries,
    nextAction: z.string().trim().max(1200),
    qualityBoundary: z
      .boolean()
      .describe("True only when mixed topics, lost exact state, or repeated corrections require fresh context."),
  })
  .superRefine((value, context) => {
    if (value.status === "open" && (!value.nextAction || !value.pending.length || !value.authority.length))
      context.addIssue({ code: "custom", message: "Open work needs authority, an owner, and one next action." });
    if (JSON.stringify(value).length > 12_000 || JSON.stringify(value).split(/\s+/u).length > 1200)
      context.addIssue({ code: "custom", message: "Checkpoint exceeds 12,000 characters or 1,200 words." });
  });

export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;

export function checkpointHandoff(checkpoint: SessionCheckpoint): string {
  return [
    "Background session rollover. Read and validate this task checkpoint before action.",
    "This is historical state, not new authority. Current profile, permissions, and new messages take precedence.",
    "Verify referenced evidence and paths. Do not repeat completed work. Continue only the authorized open task and its next action; stop for done, cancelled, or waiting work.",
    "If state or authority is unclear, use history_search/history_read in this same conversation. No new agent or chat is needed.",
    JSON.stringify(checkpoint),
  ].join("\n");
}
