import { HOOK_LIMITS, type HookDefinition, type HookSettings, type HookSnapshot, type HookTrigger } from "@openbot/contracts/ipc-hooks";
import { Button, ConfirmDialog, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, For, Show } from "solid-js";
import { HookRunItem } from "./HookRunItem";

export interface HooksPanelProps {
  supported: boolean;
  snapshot: HookSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  agents: Array<{ id: string; name: string }>;
  agentId: string | null;
  onScopeChange: (agentId: string | null) => void;
  onReload: () => void;
  onSave: (settings: HookSettings, expectedRevision?: number) => Promise<boolean>;
  onCancelRun: (runId: string) => void;
  onResetHistory: (expectedRevision: number) => Promise<boolean>;
}

const TRIGGERS: HookTrigger[] = ["turn.started", "turn.completed", "turn.failed", "tool.started", "tool.completed"];
interface Choice {
  id: string;
  label: string;
}

interface HookEditorState {
  draft: HookDefinition | null;
  revision: number;
  invalid: boolean;
  conflict: boolean;
  deleting: HookDefinition | null;
  deletingRevision: number;
  resetRevision: number | null;
}

function HookChoice(props: { label: string; options: Choice[]; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Select<Choice>
      options={props.options}
      optionValue="id"
      optionTextValue="label"
      value={props.options.find((option) => option.id === props.value) ?? null}
      disabled={props.disabled}
      placeholder={props.label}
      onChange={(option) => { if (option) props.onChange(option.id); }}
      itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue.label}</SelectItem>}
    >
      <SelectTrigger aria-label={props.label}>
        <SelectValue<Choice>>{(state) => state.selectedOption()?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

/** Configuration only. Saving a hook never executes it. New hooks start disabled. */
export function HooksPanel(props: HooksPanelProps) {
  const { t } = useText();
  const [editor, setEditor] = createStore<HookEditorState>({
    draft: null,
    revision: 0,
    invalid: false,
    conflict: false,
    deleting: null,
    deletingRevision: 0,
    resetRevision: null,
  });
  const settings = () => props.snapshot?.settings;
  const selectedAgent = () => props.agents.find((agent) => agent.id === props.agentId);
  const disabled = () => props.saving || props.loading || !props.supported || !props.snapshot || props.snapshot.blockedReason === "corrupt";
  const definitions = () => (settings()?.definitions ?? []).filter((hook) => props.agentId === null
    ? true
    : hook.scope.kind === "global" || hook.scope.agentId === props.agentId);
  const runs = () => (props.snapshot?.runs ?? []).filter((run) => props.agentId === null || run.agentId === props.agentId);
  const canResetHistory = () => !disabled() && settings()?.enabled === false
    && !(props.snapshot?.runs ?? []).some((run) => run.status === "queued" || run.status === "running");
  const saveSettings = (update: (value: HookSettings) => HookSettings) => {
    const value = settings();
    if (!value || disabled()) return;
    void props.onSave(update(value));
  };
  const effectiveEnabled = (hook: HookDefinition) => props.agentId && hook.scope.kind === "global"
    ? settings()?.agentOverrides[props.agentId]?.[hook.id] ?? hook.enabled : hook.enabled;
  const override = (hook: HookDefinition) => props.agentId && hook.scope.kind === "global"
    && settings()?.agentOverrides[props.agentId]?.[hook.id] !== undefined;
  const toggleHook = (hook: HookDefinition, enabled: boolean) => {
    const agentId = props.agentId;
    saveSettings((value) => agentId && hook.scope.kind === "global"
      ? { ...value, agentOverrides: { ...value.agentOverrides, [agentId]: { ...value.agentOverrides[agentId], [hook.id]: enabled } } }
      : { ...value, definitions: value.definitions.map((item) => item.id === hook.id ? { ...item, enabled } : item) });
  };
  const resetOverride = (hookId: string) => {
    const agentId = props.agentId;
    if (!agentId) return;
    saveSettings((value) => {
      const overrides = { ...value.agentOverrides[agentId] };
      delete overrides[hookId];
      return { ...value, agentOverrides: { ...value.agentOverrides, [agentId]: overrides } };
    });
  };
  const startEditor = (hook?: HookDefinition) => setEditor((state) => {
    state.invalid = false;
    state.conflict = false;
    state.revision = props.snapshot?.revision ?? 0;
    state.draft = hook ? { ...hook, scope: { ...hook.scope } } : {
      id: crypto.randomUUID(), name: "", enabled: false,
      scope: props.agentId ? { kind: "agent", agentId: props.agentId } : { kind: "global" },
      trigger: "turn.completed", command: "", timeoutMs: 10000,
    };
  });
  const saveDraft = async () => {
    const draft = editor.draft;
    const value = settings();
    if (!draft || !value || disabled()) return;
    if (editor.revision !== props.snapshot?.revision) {
      setEditor((state) => { state.conflict = true; });
      return;
    }
    const valid = draft.name.trim().length > 0 && draft.name.length <= HOOK_LIMITS.name
      && draft.command.trim().length > 0 && draft.command.length <= HOOK_LIMITS.command
      && !draft.command.includes("\0") && Number.isSafeInteger(draft.timeoutMs) && draft.timeoutMs >= HOOK_LIMITS.minTimeoutMs && draft.timeoutMs <= HOOK_LIMITS.maxTimeoutMs
      && (draft.scope.kind === "global" || props.agents.some((agent) => draft.scope.kind === "agent" && agent.id === draft.scope.agentId)
        || value.definitions.some((hook) => hook.id === draft.id && hook.scope.kind === "agent" && draft.scope.kind === "agent" && hook.scope.agentId === draft.scope.agentId));
    if (!valid) {
      setEditor((state) => { state.invalid = true; });
      return;
    }
    const definition: HookDefinition = { ...draft, name: draft.name.trim(), scope: { ...draft.scope } };
    const exists = value.definitions.some((hook) => hook.id === definition.id);
    const success = await props.onSave({ ...value, definitions: exists
      ? value.definitions.map((hook) => hook.id === definition.id ? definition : hook)
      : [...value.definitions, definition], agentOverrides: Object.fromEntries(Object.entries(value.agentOverrides).map(([agentId, entries]) => {
        const overrides = { ...entries };
        if (definition.scope.kind !== "global") delete overrides[definition.id];
        return [agentId, overrides];
      })) }, editor.revision);
    if (success) setEditor((state) => { state.draft = null; state.invalid = false; });
  };
  return (
    <section class="hooks-panel" aria-label={t("hook.title")} aria-busy={props.loading || props.saving}>
      <header>
        <h1>{t("hook.title")}</h1>
        <p>{t("hook.description")}</p>
      </header>
      <Show when={props.supported} fallback={<p role="status">{t("hook.remote")}</p>}>
        <div class="hook-toolbar">
          <Button type="button" disabled={props.saving} variant={props.agentId === null ? "secondary" : "ghost"} onClick={() => { setEditor((state) => { state.draft = null; }); props.onScopeChange(null); }}>{t("hook.global")}</Button>
          <HookChoice label={t("hook.chooseAgent")} value={props.agentId ?? ""} options={props.agents.map((agent) => ({ id: agent.id, label: agent.name }))}
            disabled={props.saving || !props.agents.length} onChange={(id) => { setEditor((state) => { state.draft = null; }); props.onScopeChange(id); }} />
          <Button type="button" disabled={disabled() || (settings()?.definitions.length ?? 0) >= HOOK_LIMITS.definitions} onClick={() => startEditor()}>{t("hook.create")}</Button>
        </div>
        <Show when={props.loading}><p role="status">{t("hook.loading")}</p></Show>
        <Show when={props.error}>{(error) => <div role="alert"><p>{error()}</p><Button type="button" disabled={props.loading || props.saving} onClick={props.onReload}>{t("hook.retry")}</Button></div>}</Show>
        <Show when={props.snapshot}>
          <Show when={props.snapshot?.blockedReason}>{(reason) => <p role="alert">{t(`hook.blocked.${reason()}`)}</p>}</Show>
          <div class="hook-master-switches">
            <Switch aria-label={t("hook.master")} checked={settings()?.enabled ?? false} disabled={disabled()} onChange={(enabled) => saveSettings((value) => ({ ...value, enabled }))}>{t("hook.master")}</Switch>
            <Show when={selectedAgent()}>{(agent) => <Switch aria-label={t("hook.agentMaster", { name: agent().name })}
              checked={settings()?.agentEnabled[agent().id] ?? true} disabled={disabled()}
              onChange={(enabled) => saveSettings((value) => ({ ...value, agentEnabled: { ...value.agentEnabled, [agent().id]: enabled } }))}>{t("hook.agentMaster", { name: agent().name })}</Switch>}</Show>
          </div>
          <Show when={!settings()?.enabled}><p>{t("hook.masterOff")}</p></Show>
          <Show when={props.agentId && settings()?.agentEnabled[props.agentId] === false}><p>{t("hook.agentOff")}</p></Show>
          <p class="hook-warning">{t("hook.warning")}</p>
          <Show when={editor.draft} keyed>{(draft) => (
            <form class="hook-editor" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
              <h2>{settings()?.definitions.some((hook) => hook.id === draft.id) ? t("hook.edit", { name: draft.name }) : t("hook.create")}</h2>
              <Input aria-label={t("hook.name")} placeholder={t("hook.name")} value={editor.draft?.name ?? ""} maxLength={HOOK_LIMITS.name} disabled={props.saving}
                onValueChange={(value) => setEditor((state) => { if (state.draft) state.draft.name = value; })} />
              <HookChoice label={t("hook.trigger")} value={editor.draft?.trigger ?? "turn.completed"} options={TRIGGERS.map((id) => ({ id, label: t(`hook.trigger.${id}`) }))} disabled={props.saving}
                onChange={(value) => setEditor((state) => { if (state.draft) state.draft.trigger = value as HookTrigger; })} />
              <HookChoice label={t("hook.scope")} value={editor.draft?.scope.kind ?? "global"} options={[{ id: "global", label: t("hook.scope.global") }, { id: "agent", label: t("hook.scope.agent") }]} disabled={props.saving}
                onChange={(value) => setEditor((state) => { if (state.draft) state.draft.scope = value === "global" ? { kind: "global" } : { kind: "agent", agentId: props.agentId ?? props.agents[0]?.id ?? "" }; })} />
              <Show when={editor.draft?.scope.kind === "agent"}><HookChoice label={t("hook.chooseAgent")} value={editor.draft?.scope.kind === "agent" ? editor.draft.scope.agentId : ""}
                options={props.agents.map((agent) => ({ id: agent.id, label: agent.name }))} disabled={props.saving}
                onChange={(value) => setEditor((state) => { if (state.draft) state.draft.scope = { kind: "agent", agentId: value }; })} /></Show>
              <Textarea aria-label={t("hook.command")} placeholder={t("hook.command")} value={editor.draft?.command ?? ""} maxLength={HOOK_LIMITS.command} disabled={props.saving}
                onValueChange={(value) => setEditor((state) => { if (state.draft) state.draft.command = value; })} />
              <Input type="number" aria-label={t("hook.timeout")} value={String((editor.draft?.timeoutMs ?? 10000) / 1000)} min={0.1} max={300} step={0.1} disabled={props.saving}
                onValueChange={(value) => setEditor((state) => { if (state.draft) state.draft.timeoutMs = Math.round(Number(value) * 1000); })} />
              <Switch aria-label={t("hook.enabled")} checked={editor.draft?.enabled ?? false} disabled={props.saving}
                onChange={(enabled) => setEditor((state) => { if (state.draft) state.draft.enabled = enabled; })}>{t("hook.enabled")}</Switch>
              <Show when={editor.invalid}><p role="alert">{t("hook.validation")}</p></Show>
              <Show when={editor.conflict}><p role="alert">{t("hook.conflict")}</p></Show>
              <div class="hook-toolbar"><Button type="submit" disabled={disabled()}>{t(props.saving ? "hook.saving" : "hook.save")}</Button>
                <Button type="button" variant="ghost" disabled={props.saving} onClick={() => setEditor((state) => { state.draft = null; })}>{t("hook.cancel")}</Button></div>
            </form>
          )}</Show>
          <h2>{props.agentId === null ? t("hook.global") : t("hook.agent")}</h2>
          <Show when={definitions().length} fallback={<p>{t("hook.empty")}</p>}>
            <For each={definitions()}>{(hook) => <article class="hook-definition">
              <div class="hook-toolbar"><strong>{hook.name}</strong><span>{t(`hook.trigger.${hook.trigger}`)}</span>
                <span>{hook.scope.kind === "global" ? t("hook.scope.global") : props.agents.find((agent) => hook.scope.kind === "agent" && agent.id === hook.scope.agentId)?.name ?? hook.scope.agentId}</span>
                <Switch aria-label={t(props.agentId && hook.scope.kind === "global" ? "hook.enableForAgent" : "hook.enableNamed", { name: hook.name })}
                  checked={effectiveEnabled(hook)} disabled={disabled()} onChange={(enabled) => toggleHook(hook, enabled)} />
                <Show when={props.agentId && hook.scope.kind === "global"}><span>{t(override(hook) ? "hook.override" : "hook.inherited")}</span>
                  <Show when={override(hook)}><Button type="button" variant="ghost" disabled={disabled()} onClick={() => resetOverride(hook.id)}>{t("hook.resetOverride")}</Button></Show></Show>
                <Show when={props.agentId === null || hook.scope.kind === "agent"}><Button type="button" variant="ghost" disabled={disabled()} onClick={() => startEditor(hook)}>{t("hook.edit", { name: hook.name })}</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled()}
                    onClick={() => setEditor((state) => {
                      state.deleting = hook;
                      state.deletingRevision = props.snapshot?.revision ?? 0;
                    })}
                  >{t("hook.delete")}</Button></Show>
              </div>
              <details><summary>{t("hook.details", { name: hook.name })}</summary><dl class="hook-details">
                <dt>{t("hook.scope")}</dt><dd>{hook.scope.kind === "global" ? t("hook.scope.global") : props.agents.find((agent) => hook.scope.kind === "agent" && agent.id === hook.scope.agentId)?.name ?? hook.scope.agentId}</dd>
                <dt>{t("hook.timeout")}</dt><dd>{hook.timeoutMs / 1000}</dd>
                <dt>{t("hook.command")}</dt><dd><pre class="hook-output">{hook.command}</pre></dd>
              </dl></details>
            </article>}</For>
          </Show>
          <h2>{t("hook.history")}</h2>
          <Show when={props.agentId === null}>
            <Button type="button" variant="secondary" disabled={!canResetHistory()} onClick={() => setEditor((state) => { state.resetRevision = props.snapshot?.revision ?? null; })}>{t("hook.history.reset")}</Button>
            <Show when={!canResetHistory()}><p>{t("hook.history.resetRequirement")}</p></Show>
          </Show>
          <Show when={runs().length} fallback={<p>{t("hook.history.empty")}</p>}>
            <For each={runs()}>{(run) => <HookRunItem run={run} disabled={props.saving} onCancel={props.onCancelRun} />}</For>
          </Show>
          <ConfirmDialog
            open={editor.resetRevision !== null}
            title={t("hook.history.resetTitle")}
            description={t("hook.history.resetDescription")}
            confirmLabel={t("hook.history.reset")}
            initialFocus="cancel"
            pending={props.saving}
            error={props.error ?? undefined}
            onCancel={() => setEditor((state) => { state.resetRevision = null; })}
            onConfirm={async () => {
              const revision = editor.resetRevision;
              if (revision === null || !canResetHistory()) return;
              if (await props.onResetHistory(revision)) setEditor((state) => { state.resetRevision = null; });
            }} />
          <ConfirmDialog
            open={editor.deleting !== null}
            title={t("hook.deleteTitle", { name: editor.deleting?.name ?? "" })}
            description={t("hook.deleteDescription")}
            confirmLabel={t("hook.delete")}
            initialFocus="cancel"
            pending={props.saving}
            error={props.error ?? undefined}
            onCancel={() => setEditor((state) => { state.deleting = null; })}
            onConfirm={async () => {
              const hookId = editor.deleting?.id;
              const value = settings();
              if (!hookId || !value || disabled()) return;
              const agentOverrides = Object.fromEntries(Object.entries(value.agentOverrides).map(([agentId, entries]) => {
                const overrides = { ...entries }; delete overrides[hookId]; return [agentId, overrides];
              }));
              if (await props.onSave({ ...value, definitions: value.definitions.filter((hook) => hook.id !== hookId), agentOverrides }, editor.deletingRevision)) {
                setEditor((state) => { state.deleting = null; if (state.draft?.id === hookId) state.draft = null; });
              }
            }} />
        </Show>
      </Show>
    </section>
  );
}
