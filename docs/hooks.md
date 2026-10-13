# OpenBot-managed hooks

CHA-564 adds local lifecycle hooks with visible controls and firing records. This
branch is a source-only delivery: nothing in this change has been built, compiled,
installed, launched or tested by execution. The Wizard explicitly deferred those
checks. Existing provider configuration and mandatory provider safety hooks are
outside this feature.

## User workflow

The Hooks view sits beside Routines. A user can create, inspect, edit and enable a
hook, select global or single-agent scope, and inspect recent firings. Global hooks
can be switched off for an individual bot. The global and per-bot master switches
take precedence over individual hook switches. New hooks start disabled.

A command runs when its selected OpenBot turn or tool lifecycle event occurs. The
command receives event metadata as JSON on standard input; chat contents and tool
arguments are not interpolated into shell commands. Commands are user-managed
local automation, not model-generated tool calls. The interface explains their
local-account authority outside the model sandbox before enabling them. These are
observational commands: they do not approve, deny or block provider actions. Tool
triggers follow the tool notifications that a provider emits; a provider that does
not report a tool event cannot produce a firing for it.

Every firing has a durable identifier and its original agent, thread and turn.
The originating chat shows the hook name, trigger, running or terminal result and
duration. Recent history exposes bounded, redacted output and cancellation.
Switching chats does not redirect a result to the newly selected conversation.

## Persistence and boundaries

Hook definitions, switches, per-agent overrides and recent run records are local
settings. Saves use revision checking so stale windows cannot silently overwrite
newer commands or switches. Malformed storage fails closed and is preserved.
Interrupted runs are recorded on recovery; they are not replayed as new commands.
Duplicate lifecycle delivery is deduplicated. Hook-generated activity does not
trigger more hooks.

The main process stores settings and receipts in `openbot-hooks-v1.json` under the
Electron user-data directory. There are at most 100 definitions, 200 recent runs,
20,000 deduplication records, and 16 KiB of combined output per run. The original
chat keeps its own durable firing items. A command runs for at most five minutes;
only one command runs at a time. Editing, deleting or disabling a queued definition
prevents that accepted command from starting. Use Cancel to stop a running command.

A full deduplication ledger stops new firings and shows a warning. Turn the global
master off, wait for or cancel unfinished runs, then confirm Reset history. This
clears recent history and deduplication keys, and preserves hook definitions,
switches and existing chat records. The reset itself runs no command. A repeated
event can fire again after its old deduplication record is cleared. Reset cannot
overwrite corrupt storage.

The runner uses POSIX shells and process groups. Windows commands fail visibly.
A separate guardian watches the application pipe and terminates the command group
if the application exits. A command that deliberately leaves its process group is
outside this cancellation boundary. Command output uses the standard redactors;
commands must not print secrets.

This implementation is local desktop functionality. Remote Team clients do not
receive command-management authority through this feature, and released Team API
wire protocols remain unchanged. Bots have no hook-configuration tool.

## Required later verification

After the Wizard authorizes execution, run the focused source tests, affected
type checks and lint, then use an isolated development profile to verify global
and per-bot controls, chat firing updates, reload persistence, timeout/cancel,
restart recovery and malformed-settings handling. Inspect both success and failure
on actual providers, including tool events. Check remote unavailability and output
redaction. Do not replace or restart the installed app as part of that check.

Source review and a local commit do not establish that these runtime behaviors
work. No screenshots or runtime proof are claimed for this delivery.
