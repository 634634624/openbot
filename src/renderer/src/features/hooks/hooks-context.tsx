import type { HookSettings, HookSnapshot } from "@openbot/contracts/ipc-hooks";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import type { HooksPort } from "./hooks-port";

interface HooksState {
  snapshot: HookSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  agentId: string | null;
}

const Hooks = createSimpleContext({
  name: "Hooks",
  init: (props: { port: HooksPort | null; agentId: string | null }) => {
    const { t, errorMessage } = useText();
    const [state, setState] = createStore<HooksState>({
      snapshot: null,
      loading: false,
      saving: false,
      error: null,
      agentId: props.agentId,
    });
    let generation = 0;
    let updates = 0;
    const accept = (snapshot: HookSnapshot) => {
      if (state.snapshot && snapshot.revision < state.snapshot.revision) return;
      updates++;
      setState((value) => {
        value.snapshot = snapshot;
      });
    };
    const reload = async () => {
      const port = props.port;
      if (!port) return;
      const current = generation;
      const before = updates;
      setState((value) => {
        value.loading = true;
        value.error = null;
      });
      try {
        const snapshot = await port.get();
        if (current === generation && before === updates) accept(snapshot);
      } catch (error) {
        if (current === generation)
          setState((value) => {
            value.error = errorMessage(error, t("hook.loadFailed"));
          });
      } finally {
        if (current === generation)
          setState((value) => {
            value.loading = false;
          });
      }
    };
    createEffect(
      () => props.port,
      (port) => {
        generation++;
        setState((value) => {
          value.snapshot = null;
          value.error = null;
          value.loading = false;
          value.saving = false;
        });
        if (!port) return;
        const current = generation;
        const unsubscribe = port.subscribe((snapshot) => {
          if (generation === current) accept(snapshot);
        });
        void reload();
        return () => {
          generation++;
          unsubscribe();
        };
      },
    );
    createEffect(
      () => props.agentId,
      (agentId) => {
        setState((value) => {
          value.agentId = agentId;
        });
      },
    );
    const mutate = async (operation: (port: HooksPort, snapshot: HookSnapshot) => Promise<HookSnapshot>) => {
      const port = props.port;
      const snapshot = state.snapshot;
      if (!port || !snapshot || state.saving || state.loading || snapshot.blockedReason === "corrupt") return false;
      const current = generation;
      const before = updates;
      setState((value) => {
        value.saving = true;
        value.error = null;
      });
      try {
        const result = await operation(port, snapshot);
        if (current !== generation) return false;
        if (before === updates || result.revision > (state.snapshot?.revision ?? -1)) accept(result);
        return true;
      } catch (error) {
        if (current === generation)
          setState((value) => {
            value.error = errorMessage(error, t("hook.saveFailed"));
          });
        return false;
      } finally {
        if (current === generation)
          setState((value) => {
            value.saving = false;
          });
      }
    };
    return {
      state,
      reload,
      setScope: (agentId: string | null) => {
        setState((value) => {
          value.agentId = agentId;
        });
      },
      save: (settings: HookSettings, expectedRevision?: number) =>
        mutate((port, snapshot) => port.save(settings, expectedRevision ?? snapshot.revision)),
      cancelRun: (runId: string) => {
        void mutate((port) => port.cancelRun(runId));
      },
      resetHistory: (expectedRevision: number) => mutate((port) => port.resetHistory(expectedRevision)),
    };
  },
});

export const HooksProvider = Hooks.provider;
export const useHooks = Hooks.use;
