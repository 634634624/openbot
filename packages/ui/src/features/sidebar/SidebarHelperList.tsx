import { For, Show } from "solid-js";
import { Button } from "../../button";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";

/** Active helpers follow their parent in every placement, without independent layout state. */
export function SidebarHelperList(props: { parentId: string }) {
  const scope = useSidebarScope();
  const { t } = useText();
  const helpers = () =>
    scope.props.agents.filter(
      (agent) =>
        agent.helper?.parentAgentId === props.parentId &&
        (agent.helper.status === "queued" || agent.helper.status === "running"),
    );
  return (
    <Show when={helpers().length > 0}>
      <ul class="sidebar-helper-list" aria-label={t("agent.helper.history")}>
        <For each={helpers()}>
          {(agent) => (
            <li>
              <Button
                variant="ghost"
                size="sm"
                class="sidebar-helper-row"
                draggable={false}
                aria-pressed={scope.props.activeAgentId === agent.id ? "true" : "false"}
                onClick={(event) => {
                  event.stopPropagation();
                  scope.props.onSelectAgent(agent.id);
                }}
              >
                <span>{agent.name}</span>
                <small>
                  {agent.helper?.status === "running" ? t("agent.helper.running") : t("agent.helper.queued")}
                </small>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
