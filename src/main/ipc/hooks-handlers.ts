import {
  type CancelHookRunInput,
  type HookSnapshot,
  isCancelHookRunInput,
  isResetHookHistoryInput,
  isSaveHookSettingsInput,
  type ResetHookHistoryInput,
  type SaveHookSettingsInput,
} from "@openbot/contracts/ipc-hooks";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { HookFailure } from "../../backend/hooks/hook-store";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

interface HooksIpcDependencies {
  hooks: {
    snapshot(): HookSnapshot;
    saveSettings(input: SaveHookSettingsInput): Effect.Effect<HookSnapshot, HookFailure>;
    cancelRun(id: string): Effect.Effect<void, HookFailure>;
    resetHistory(input: ResetHookHistoryInput): Effect.Effect<HookSnapshot, HookFailure>;
  };
  agentIds(): readonly string[];
}

/** These endpoints exist only on this desktop. No Team route or bot tool can call them. */
export function hooksIpcHandlers({ hooks, agentIds }: HooksIpcDependencies): Pick<IpcGroupHandlers, "hooks"> {
  function saveInput(value: unknown): SaveHookSettingsInput {
    if (!isSaveHookSettingsInput(value)) throw new Error(sourceText("error.backend.hooksInvalid"));
    const known = new Set(agentIds());
    const previous = hooks.snapshot().settings;
    // A deleted bot must not freeze every settings save. Existing orphan references can be kept
    // or removed; a new reference must name a current local bot.
    const invalidToggle = Object.keys(value.settings.agentEnabled).some(
      (id) => !known.has(id) && !Object.hasOwn(previous.agentEnabled, id),
    );
    const invalidOverride = Object.keys(value.settings.agentOverrides).some(
      (id) => !known.has(id) && !Object.hasOwn(previous.agentOverrides, id),
    );
    const invalidDefinition = value.settings.definitions.some((hook) => {
      if (hook.scope.kind !== "agent" || known.has(hook.scope.agentId)) return false;
      const old = previous.definitions.find((entry) => entry.id === hook.id);
      return old?.scope.kind !== "agent" || old.scope.agentId !== hook.scope.agentId;
    });
    if (invalidToggle || invalidOverride || invalidDefinition)
      throw new Error(sourceText("error.backend.hooksAgentMissing"));
    return value;
  }
  function cancelInput(value: unknown): CancelHookRunInput {
    if (!isCancelHookRunInput(value)) throw new Error(sourceText("error.backend.hooksInvalid"));
    return value;
  }
  return {
    hooks: {
      get: handler(() => hooks.snapshot()),
      save: payloadHandler(saveInput, (input) =>
        Effect.runPromise(
          hooks
            .saveSettings(input)
            .pipe(
              Effect.mapError(
                (failure) =>
                  new Error(
                    failure.reason === "stale"
                      ? sourceText("error.backend.hooksStale")
                      : sourceText("error.backend.hooksSaveFailed"),
                  ),
              ),
            ),
        ),
      ),
      cancelRun: payloadHandler(cancelInput, async ({ runId }) => {
        await Effect.runPromise(
          hooks.cancelRun(runId).pipe(Effect.mapError(() => new Error(sourceText("error.backend.hooksCancelFailed")))),
        );
        return hooks.snapshot();
      }),
      resetHistory: payloadHandler(
        (value): ResetHookHistoryInput => {
          if (!isResetHookHistoryInput(value)) throw new Error(sourceText("error.backend.hooksInvalid"));
          return value;
        },
        (input) =>
          Effect.runPromise(
            hooks
              .resetHistory(input)
              .pipe(
                Effect.mapError(
                  (failure) =>
                    new Error(
                      failure.reason === "stale"
                        ? sourceText("error.backend.hooksStale")
                        : sourceText("error.backend.hooksResetFailed"),
                    ),
                ),
              ),
          ),
      ),
    },
  };
}
