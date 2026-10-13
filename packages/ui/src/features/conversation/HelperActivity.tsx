import { Button } from "@openbot/ui";
import { For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";

const statusKeys = {
  queued: "agent.helper.queued", running: "agent.helper.running", completed: "agent.helper.completed",
  failed: "agent.helper.failed", cancelled: "agent.helper.cancelled",
} as const;

/** Active job details and retained helper history; consumers own selection and cancellation. */
export function HelperActivity(props: {
  agent: AgentProfile | null | undefined;
  agents: AgentProfile[];
  onSelect: (id: string) => void;
  onStop?: () => void;
  onCancelQueued?: () => void;
}) {
  const { t } = useText();
  const helper = () => props.agent?.helper;
  const children = () => props.agents.filter((agent) => agent.helper?.parentAgentId === props.agent?.id);
  return <>
    <Show when={helper()}>{(job) => <section class="helper-activity" aria-label={t("agent.helper.history")}>
      <strong>{t("agent.helper.runs", { parent: job().parentAgentName, helper: props.agent?.name ?? "" })}</strong>
      <span>{t(statusKeys[job().status])} · {job().role}</span>
      <small>{t("agent.helper.model", { provider: props.agent?.provider ?? "", model: props.agent?.model ?? "" })}</small>
      <p>{t("agent.helper.readOnly")}</p>
      <Button variant="ghost" size="sm" onClick={() => props.onSelect(job().parentAgentId)}>
        {t("agent.helper.return", { name: job().parentAgentName })}
      </Button>
      <Show when={job().status === "running" && props.onStop}>
        <Button variant="outline" size="sm" onClick={() => props.onStop?.()}>{t("agent.helper.stop")}</Button>
      </Show>
      <Show when={job().status === "queued" && props.onCancelQueued}>
        <Button variant="outline" size="sm" onClick={props.onCancelQueued}>{t("agent.helper.cancel")}</Button>
      </Show>
      <details><summary>{t("agent.helper.brief")}</summary><pre>{job().claim}{"\n\n"}{job().acceptance}{"\n\n"}{job().scope}</pre></details>
      <Show when={job().result}><details><summary>{t("agent.helper.result")}</summary><pre>{job().result}</pre></details></Show>
    </section>}</Show>
    <Show when={children().length > 0}>
      <details class="helper-activity" open={children().some((agent) => agent.helper?.status === "running" || agent.helper?.status === "queued")}>
        <summary>{t("agent.helper.history")}</summary>
        <ul><For each={children()}>{(agent) => <li>
          <Button variant="ghost" size="sm" onClick={() => props.onSelect(agent.id)}>
            {t("agent.helper.runs", { parent: props.agent?.name ?? "", helper: agent.name })}
            {" · "}{t(statusKeys[agent.helper?.status ?? "failed"])}
          </Button>
        </li>}</For></ul>
      </details>
    </Show>
  </>;
}
