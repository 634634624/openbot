# Temporary helper jobs

This change is source-only. No build, type check, test, or application run was performed.

## Tool API

`spawn_helper({ name, role, personality?, claim, acceptance, scope, provider?, model?, reasoningEffort? })` creates one job. Omitted model settings inherit the parent when supported; explicit choices must exist in the provider catalog. The tool returns the helper profile, including `helper.jobId`. `cancel_helper({ jobId })` accepts only a job owned by the caller. `list_agents` includes active helpers; completed jobs remain in the local parent history.

The role, claim, acceptance and scope are separate fields for pstack gates. No role maps to a hard-coded model. The first user message contains only the explicit claim, acceptance and scope. The helper has a new workspace and provider session, not the parent's chat.

## Lifecycle and storage

`AgentStore` saves the parent link, brief, initial queued state, access and Computer Use limits in the initial profile record. Automation and notifications start disabled. No schema migration is needed. Spawn requests are serialized and use the originating tool-call key to avoid duplicate jobs. Helpers have a separate retained-history cap of 1,000; they do not consume the persistent roster limit.

Only the initial mailbox delivery is accepted. The helper cannot create more agents, change profiles, send teammate messages, schedule routines, join channels or register waits through OpenBot tools. These are application rules, not an operating-system sandbox; the helper inherits the parent's access boundary.

Provider turn events move a job through queued, running, and completed, failed or cancelled. Cancellation intent persists before interruption; a turn that is still starting receives the interrupt when it starts. Setup failures preserve a failed job. On restart, interrupted jobs fail visibly instead of running a second time. Terminal jobs deliver their full bounded result through an idempotent mailbox message and do not drain another turn.

Disposal means removal from the active sidebar and rejection of further work. Workspace, identity, conversation and result remain local for review. This change does not delete user files or introduce automatic retention deletion.

## UI and result routing

Active helpers render as small nested list rows below their parent, including pinned parents. Helpers have a read-only conversation with job details, model, status, result, stop/cancel controls, and a return-to-parent action. Parent chats expose retained helper history. Profile and composer controls are disabled for a helper.

One system item in the exact originating parent thread changes as the job progresses. It states who runs which helper, the role, status and result. The final mailbox message wakes the parent's current conversation and names the originating thread. If the user has changed the parent's active thread, the durable audit item stays in the original thread and the wakeup goes to the current one.

Desktop composition enables this feature. Server composition leaves it disabled. Released Team API views omit helper identities; normal parent chat text can still show the result. No released protocol shape changes.

## Static evidence and deferred validation

Source review covered lifecycle integration, initial permissions, duplicate requests, cancellation intent, UI props/exports and protocol filtering. Regression test source covers explicit independent briefs, extra-work rejection, concurrent spawn retries, nested helper rejection, cancellation ownership and remote roster filtering. These tests were not executed.

After the Wizard approves execution: install only if needed, type-check the affected workspaces, run the helper and provider-visibility tests, then exercise success, failure, cancel-during-start, restart recovery, duplicate result retries, every available provider, sidebar selection, pinned-parent drag and parent-thread switching in a separate development app. Do not replace or restart the installed app.
