# Temporary helpers attached to a parent conversation

Proposal, not an implemented feature. Investigated 2026-10-13 at base
`68562509e90042cc1c2671b067d8d454f3c67a4a`.

## Problem

A bot needs a reviewer, investigator or tester for one bounded task. Creating a
persistent teammate leaves permanent sidebar clutter and requires cleanup. Native
provider subagent events show some activity, but do not provide a uniform,
user-visible helper lifecycle across providers.

## Proposed behavior

A parent bot starts a named helper with a small role/personality description, one
task and a model selected from OpenBot's current catalog. A helper called Reviewer
can investigate independently while the parent continues. The chat shows
“Parent bot runs Reviewer”. The sidebar shows a smaller active child underneath
its parent. Selecting it opens the task and activity; Cancel stops this helper.

At success, failure or cancellation, its active sidebar row disappears. The
parent conversation retains the result or failure, identity, selected provider
and model, and evidence references. Disappearing must not mean deleting history.
One completion is delivered to the originating parent thread even when the
parent is currently idle. No permanent agent or routine is created.

Keep the first slice narrow: one parent level, one task per helper, no helper
routines, no helper-created helpers, no provider-specific pstack implementation.
Roles such as reviewer, verifier and writer are ordinary instructions. Model
selection remains configuration, separate from reusable role instructions.

## Current route and source anchors

These are source findings at the pinned base, not proof of installed behavior.

- `src/backend/agent/profile-tools.ts`, `createAgentToolSchema`: persistent agent
  creation, no parent or lifetime input.
- `src/backend/agent/openbot-tool-router.ts`, `#createAgent`: catalog validation
  and inherited restrictions. Reuse these checks, not arbitrary model strings.
- `src/backend/agent/model-tools.ts`, `requestedToolModel`: model selection.
- `packages/contracts/src/agent-providers.ts`: provider configuration is shared;
  do not hard-code three preferred providers in a new helper API.
- `src/backend/agent/thread-items.ts`: provider helper events already feed task
  activity. Adapt where useful; do not mistake an activity category for a helper
  lifecycle API.
- `src/backend/claude-client.ts`: background task/process lifetime and parent
  output filtering already exist for one provider.
- `packages/contracts/src/ipc-sidebar-layout.ts`: sections are flat today.
- `packages/contracts/src/ipc-agents.ts`, `AgentSummary`: no parent/lifetime.
- `src/backend/agent/agent-removal.ts`, `AgentRemoval.delete`: destructive
  persistent-agent removal is inappropriate for automatic helper completion.

## Minimal contract and ownership

A proposed `spawn_helper` tool accepts name, role instructions, task, and an
optional validated provider/model/effort selection. It returns a job id and
status. Parent agent, conversation and initiating turn are derived from the
trusted caller; callers cannot choose another parent. A cancel operation takes
that job id and verifies ownership. The renderer cannot grant tool permissions.

Persist a distinct helper-job record with origin, configuration snapshot,
queued/running/terminal status, timestamps, result reference and completion
receipt. Keep active projection separate from durable history. Give completion
an idempotency key so a restart cannot double-deliver. Reconcile interrupted
jobs on restart; surface unknown/interrupted, never fabricated success.

Permissions must be no broader than the parent's effective limits. Provider
changes cannot widen workspace, Computer Use, auto-approval, MCP or network
access. Preserve normal permission prompts. Do not copy secret values into task
records or UI summaries. Route only relevant context, not the entire parent's
history by default; show the submitted brief and context provenance.

Every supported provider must declare capability. If a provider cannot run a
helper, fail visibly before dispatch; never silently substitute a model. The
first implementation may expose a tested subset of providers and report the
rest as unsupported. Reuse existing scheduling and process cleanup; avoid a
second general agent scheduler. Concurrency follows existing limits.

## Acceptance and failure proof

| Scenario | Required result | Proof |
| --- | --- | --- |
| One helper finishes | Nested active row and chat activity, one retained result, row removed | UI smoke capture and lifecycle test |
| Helper fails or is cancelled | Terminal cause retained, no success claim, resources released | Provider failure/cancel test |
| Parent changes thread while helper runs | Result reaches original thread | Origin routing test |
| Completion repeats or app restarts | One result, reconciled lifecycle | Persistence/replay test |
| Unknown model/provider | Visible rejection, no silent fallback | Catalog-validation test |
| Restricted parent | No wider helper access | Permission intersection test |
| Parent removal | Stop/reconcile job safely; preserve existing deletion semantics | Parent lifecycle test |
| Native subagent activity | No duplicate synthetic helper rows/results | Event adapter test |
| Remote/team/mobile surfaces | Consistent active and terminal states or explicit supported-surface limit | Contract/renderer smoke tests |

The implementation must follow repository IPC validation, queue serialization,
atomic persistence and migration rules. Update contract mocks and affected UI
surfaces together. Add no new network service, paid route, or runtime dependency
for this feature. Run narrow affected tests; CI owns broad checks.

## Alternatives considered

Persistent teammates with one-task briefs work now and preserve independent
identity. They remain persistent and flat. A section reduces visual clutter but
cannot express parenthood. Native provider helpers work for some routes but do
not satisfy cross-provider selection or lifecycle UI. Reusing persistent-agent
delete would discard valuable history and is rejected.

## Security and local-data impact

The proposal adds local helper-job metadata and activity/result references. It
uses existing provider connections and permission limits. It must not introduce
new default permissions, expose secrets or send unrelated local context to a
provider. No runtime, schema or permission change is implemented in this branch.

## Verification and publication state

This branch contains only this design. Source anchors were inspected; supplied
current-state capture and a clearly labeled wanted-state mockup are held outside
the repository. Neither image proves implemented helper behavior. No application
build or runtime test is claimed.

Issue and PR duplicate searches were attempted through the GitHub connector on
2026-10-13; both returned USER_NOT_LOGGED_IN. Duplicates are **not cleared**.
Before submission, the submitter must search open and closed issues/PRs for
subagent, temporary helper and nested sidebar, then adapt to any existing work.
Publication and implementation remain separate follow-up decisions.
