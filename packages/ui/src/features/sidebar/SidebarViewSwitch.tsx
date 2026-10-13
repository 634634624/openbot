/** The switch over the list: open a chat's conversation, or its routines on the canvas. */

import { Bot, SlidingTabs, Workflow } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarView } from "./sidebar-types";

const VIEWS = ["agents", "routines", "hooks"] as const satisfies readonly SidebarView[];

function isSidebarView(value: string): value is SidebarView {
  return VIEWS.some((view) => view === value);
}

export function SidebarViewSwitch() {
  const { props } = useSidebarScope();
  const { t } = useText();
  return (
    <div class="sidebar-view-switch" data-hooks={props.showHooks ? "true" : undefined}>
      <SlidingTabs.Root
        value={props.view ?? "agents"}
        onChange={(value: string) => {
          if (isSidebarView(value)) props.onViewChange?.(value);
        }}
      >
        <SlidingTabs.List class="sidebar-view-tabs" aria-label={t("sidebar.view.label")}>
          <SlidingTabs.Trigger value="agents" class="sidebar-view-tab">
            <Bot aria-hidden="true" />
            {t("sidebar.view.agents")}
          </SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="routines" class="sidebar-view-tab">
            <Workflow aria-hidden="true" />
            {t("sidebar.view.routines")}
          </SlidingTabs.Trigger>
          <Show when={props.showHooks}>
            <SlidingTabs.Trigger value="hooks" class="sidebar-view-tab">
              {t("sidebar.view.hooks")}
            </SlidingTabs.Trigger>
          </Show>
        </SlidingTabs.List>
      </SlidingTabs.Root>
    </div>
  );
}
