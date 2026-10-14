# Background session rollover

This source change adds a structured checkpoint and bounded background continuations in a fresh
provider session, keeping the same agent and visible chat. It does not change the installed OpenBot
app.

## Policy and ownership

`session-checkpoint.ts` owns the bounded provider-facing schema. `session-rollover.ts` owns its
atomic private journal and the serialized automatic attempts. `TurnLifecycle` waits for tool/image
operations and mailbox associations before releasing the active writer. `DrainScheduler` owns
serialization and user-message precedence. `ThreadLifecycle` persists the checkpoint handoff before
binding the new provider session. The old session loses routing before the new writer starts.

The 80% trigger is the existing local OpenBot policy, not a percentage required by Anthropic. The
percentage route requires measured usage and a context window. The explicit quality-boundary route
requires a valid open checkpoint on a supported adapter. Neither route infers full-context usage
from missing or estimated telemetry. A checkpoint does not grant permissions or turn
waiting/cancelled work into open work. Current profile settings, Stops, approvals, and new messages
stay authoritative.

The checkpoint records goal, constraints, authority, decisions, completed results with evidence,
pending requests and owners, paths, and one next action. The continuation must read it and verify
referenced evidence before acting. The runtime validates structure and origin; it cannot
independently prove that the model's semantic summary is complete or that every referenced result is
correct.

The implementation applies the structured progress/reset principles from Anthropic's [harness
design](https://www.anthropic.com/engineering/harness-design-long-running-apps) and [long-running
agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
The local `auto-session-continuation` and `handoff` skills supply the bounded current-task
checkpoint contract. Their CLI/newchat routes are not used by this runtime and no second bot is
created.

## Measured coverage

| Provider path | Trigger coverage | Continuation evidence |
| --- | --- | --- |
| Actual company Codex app-server, Sol medium | Explicit quality boundary | Three distinct real sessions; three valid checkpoint saves; early format/no-send constraint retained; PREP_DONE retained; final SAFE COMPLETE |
| Injected events adapter | 82% exact usage; 79%, absent/estimated usage refused | Full AgentService queue/turn lifecycle and fresh session |
| Injected native adapter | Explicit quality boundary; percentage estimate refused | Fresh session through the same service path |
| Injected request adapter | Existing same-session compaction regression | Fresh rollover uses its common protocol capability; no live provider validation |
| Unsupported adapter | Both routes refused | No fresh session |
| Actual Claude and other providers | Not measured | No live coverage claim |

The isolated Codex test replaces only thread configuration to suppress inherited skills, hooks,
plugins, MCP servers and project instructions. The branch's actual next-turn input is forwarded
unchanged. The existing ChatGPT account is used through CODEX_HOME; no credentials are copied, no
app is restarted, and no live OpenBot database is read or written. This is headless runtime
integration, not installed-app or GUI acceptance.

## Checks and evidence

The new `session-rollover.test.ts` has 26 focused cases: exact trigger/no trigger, estimated/missing
telemetry, unsupported mode, native quality boundary, invalid/missing/stale checkpoint,
done/cancelled/ waiting state, explicit Stop, post-checkpoint tool action, user-message races before
completion and during thread creation, failed start, missing persisted handoff, uncertain turn
start, retired-writer exclusion, and refusal of repeated boundaries without progress, eight-hop
bound, and further-boundary Stop/message precedence. Two subprocess cases SIGKILL the AgentService
worker at checkpoint and uncertain-start journal writes, start a new service on the same temporary
database, prove dispatch is held, then inject provider turn-start/completion evidence before exactly
one authoritative queued delivery can start. The service continuation test retains an early
constraint and completed evidence. The writer real Codex test verifies the model's final response
and three successful checkpoint saves, including the final status done. Correctable malformed
arguments may be refused and retried in the same turn; the test requires a successful corrected
save, not a hidden acceptance of malformed state.

```sh
PATH=/Users/macbook/.bun/bin:$PATH bun run test:desktop -- \
  src/backend/agent/session-rollover.test.ts \
  src/backend/agent/context-compaction.test.ts \
  src/backend/agent-service.helper-independent.test.ts \
  src/backend/conversation-snapshots.test.ts \
  src/backend/agent/conversation-transaction.test.ts
node node_modules/vitest/vitest.mjs run --config .openbot-build/rollover/harness.config.ts
PATH=/Users/macbook/.bun/bin:$PATH bun run typecheck:node
```

Writer evidence is retained in `.openbot-build/rollover`: `final-focused-tests.log`, `three-session-
real-result.json`, `three-session-real-diagnostic.json`, `three-session-real-wire.jsonl`, `three-
session-real-run.log`, the isolated transport and real test source, plus restart JSON receipts,
baseline/candidate type and compaction logs. An evidence manifest binds source and artifacts. The
earlier real runs are retained: the first missed a refused final checkpoint; the second caught it.
The repaired two-session run proves both saves; the final three-session run records three accepted
saves and binds unchanged runtime source hashes across execution. Correctable argument refusals are
retained in earlier runs. A permission-denied checkpoint write also retains the post-checkpoint
invalidation flag. `ConversationRuntime.ensureSnapshot` now compares the resolved public thread ID,
preserving the active writer when a provider item uses its external session ID.

The final focused command passes 72 tests in five files (26 rollover cases, 11 compaction cases, 2
helper cases, and 33 snapshot/transaction regressions). The first commit attempt was rejected by
baseline type errors; the follow-up narrowly repairs those prerequisites. The branch is
`oracle/session-rollover`, based on `d4f4d828387a588d7a74512460444d9438a32b3d`. No hook is bypassed.

The base revision already fails node type checks: missing `toTurnOperationFailed` in agent-service
helper hooks, and invalid helper source translation keys/arity in `helper-jobs.ts`. Candidate type
checks now pass after exporting/reusing the existing typed failure wrapper and exposing the existing
English helper templates in the source catalog. The original compaction test read request logs
before the turn-started events settled; it now waits for those two actual events and retains all
assertions (11/11 pass). Baseline failures are retained. The optional i18n catalog check still
reports only the pre-existing unused `agent.helper.open` key, independently reproduced with the HEAD
source catalog; this patch does not remove unrelated UI catalog keys. The mandatory hook also exposed the baseline
helper row passing a boolean ARIA value where the installed Solid types require string literals.
The row now uses the same true/false strings as the surrounding sidebar rows; selection and styling
are unchanged. The renderer baseline error is retained in `baseline-renderer-types.log`. Biome formats some existing
lines in touched files as required by the repository hook.

## Recovery and limits

Journal writes use an atomic rename with private directory/file permissions. A checkpoint or thread
start failure preserves the prior binding and saved state. A failure after replacement binding keeps
its separately persisted handoff for the next genuine input. A request marked starting is never
replayed automatically, because a timeout or crash may occur after the provider accepted it. An
uncertain start holds the local drain until provider lifecycle evidence arrives. If that evidence
never arrives, manual provider/session recovery is required; the runtime cannot safely infer that
the writer stopped. There is no automatic timeout retry.

Startup loads and marks unfinished journals held before providers or queues start. The currently
bound session alone regains routing; observation of its writer holds the ordinary queue through its
completion. Pre-crash checkpoints cannot trigger continuation because later tools or Stops may have
lost transient flags. SIGKILL/restart at persisted checkpoint and uncertain turn/start is tested
with injected provider evidence, including zero automatic replay and exactly one subsequent genuine
queued delivery. No live provider crash matrix, power-loss guarantee, or automatic history-based
uncertainty resolution is claimed. If no lifecycle evidence arrives, manual session recovery remains
required.

A later automatic round can trigger another boundary only after recording an additional completed
result with evidence. The runtime retains earlier constraints/authority/completed evidence and uses
a persisted hop count. Repeated completed results or changed evidence on the same result do not
count as progress. At eight automatic hops per genuine input it stops; the writer receives that
budget and must report remaining work. This is a finite local safety policy, not unlimited
autonomous task completion. A model can still misdescribe semantic progress; the bound prevents
endless rollover, not invented facts. Helpers and execution/channel chats are excluded.

## Activation and rollback

Installed/enabled: **no**. The official installed 0.38.2 app is untouched; this source checkout is
0.38.0. Do not replace it with this checkout or patch its ASAR. First complete Oracle's acceptance.
Then integrate the patch into an official release based on the current upstream app and install that
release through the normal update route. A separate isolated development app is an alternative only
with explicit user approval; it must use its own profile and database.

Source rollback is a normal revert of the eventual rollover commit, followed by normal release
validation. Before activation, rollback means leaving this branch unshipped. This patch adds no
database migration. Keep checkpoint and handoff artifacts; do not delete or edit live database rows.
The previous official app remains the installed fallback; app downgrade compatibility still follows
its release rules.
