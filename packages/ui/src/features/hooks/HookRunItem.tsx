import type { HookRun } from "@openbot/contracts/ipc-hooks";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";

/** A saved firing updates in place as its status changes. Viewing it never reruns its command. */
export function HookRunItem(props: { run: HookRun; onCancel?: (runId: string) => void; disabled?: boolean }) {
  const { t, format, sourceText } = useText();
  const duration = () => {
    const run = props.run;
    if (!run.startedAt || !run.finishedAt) return t("hook.run.durationPending");
    const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    return Number.isFinite(elapsed)
      ? t("hook.run.durationValue", { duration: format.number(Math.max(0, elapsed)) })
      : t("hook.run.durationPending");
  };
  return (
    <details class="hook-run-item">
      <summary>
        {t("hook.run.summary", {
          name: props.run.hookName,
          trigger: t(`hook.trigger.${props.run.trigger}`),
          result: t(`hook.run.${props.run.status}`),
          duration: duration(),
        })}
      </summary>
      <dl class="hook-details">
        <dt>{t("hook.trigger")}</dt>
        <dd>{t(`hook.trigger.${props.run.trigger}`)}</dd>
        <dt>{t("hook.run.result")}</dt>
        <dd>{t(`hook.run.${props.run.status}`)}</dd>
        <dt>{t("hook.run.duration")}</dt>
        <dd>{duration()}</dd>
        <Show when={props.run.startedAt}>{(started) => <>
          <dt>{t("hook.run.started")}</dt>
          <dd>{format.date(new Date(started()))}</dd>
        </>}</Show>
        <Show when={props.run.exitCode !== null}>
          <dt>{t("hook.run.exitCode")}</dt>
          <dd>{props.run.exitCode}</dd>
        </Show>
      </dl>
      <h4>{t("hook.run.output")}</h4>
      <pre class="hook-output">{props.run.stdout || t("hook.run.noOutput")}</pre>
      <Show when={props.run.stderr}>
        <h4>{t("hook.run.stderr")}</h4>
        <pre class="hook-output">{sourceText(props.run.stderr)}</pre>
      </Show>
      <Show when={props.run.truncated}><p>{t("hook.run.truncated")}</p></Show>
      <Show when={props.onCancel && (props.run.status === "queued" || props.run.status === "running")}>
        <Button type="button" variant="secondary" disabled={props.disabled} onClick={() => props.onCancel?.(props.run.id)}>{t("hook.run.cancel")}</Button>
      </Show>
    </details>
  );
}
