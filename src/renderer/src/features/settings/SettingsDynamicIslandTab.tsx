import {
  type AppVariant,
  DEFAULT_DYNAMIC_ISLAND_PREFERENCE,
  DYNAMIC_ISLAND_SIZE_LIMITS,
  type DynamicIslandGeometry,
  type DynamicIslandNotchSize,
  IDLE_DYNAMIC_ISLAND_PRESENTATION,
} from "@openbot/contracts/ipc";
import { Button, ItemGroup, SettingsSection, SliderField, SwitchField } from "@openbot/ui";
import { OpenBotDynamicIsland } from "@openbot/ui/features/dynamic-island/OpenBotDynamicIsland";
import type { GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import { useI18n } from "../../i18n-context";

const PREVIEW_NOTCH_SIZE: DynamicIslandNotchSize = { width: 192, height: 32 };
/** The space the preview keeps on each side of an island that it scales down to fit. */
const PREVIEW_FIT_INSET = 12;

export interface SettingsDynamicIslandTabProps {
  value: GeneralSettingsValue;
  /** The previews draw the logo in the color of this build, as the real island does. */
  variant: AppVariant;
  /**
   * The built-in display's notch, or null when it has none: the built-in preview then draws the
   * island that display shows. Undefined before main answers, and the preview draws a notch.
   */
  builtInDisplayGeometry?: DynamicIslandGeometry;
  onUpdateSetting: <Key extends keyof GeneralSettingsValue>(key: Key, value: GeneralSettingsValue[Key]) => void;
  /** Saves several fields as one change, so a reset writes the preference once. */
  onUpdateSettings: (patch: Partial<GeneralSettingsValue>) => void;
}

/**
 * The Dynamic Island switches and its size.
 *
 * Each slider step saves at once, so the island on the screen follows the thumb during a drag. A
 * step is 5%, so one drag across the track writes the preference at most 12 times.
 */
export function SettingsDynamicIslandTab(props: SettingsDynamicIslandTabProps) {
  const i18n = useI18n();
  const widthPercent = () => props.value.macBookNotchWidthPercent;
  const heightPercent = () => props.value.macBookNotchHeightPercent;
  const builtInNotchSize = (): DynamicIslandNotchSize | undefined =>
    props.builtInDisplayGeometry === null ? undefined : (props.builtInDisplayGeometry ?? PREVIEW_NOTCH_SIZE);
  const isDefaultSize = () =>
    props.value.macBookNotchWidthPercent === DEFAULT_DYNAMIC_ISLAND_PREFERENCE.widthPercent &&
    props.value.macBookNotchHeightPercent === DEFAULT_DYNAMIC_ISLAND_PREFERENCE.heightPercent;

  function resetSize(): void {
    props.onUpdateSettings({
      macBookNotchWidthPercent: DEFAULT_DYNAMIC_ISLAND_PREFERENCE.widthPercent,
      macBookNotchHeightPercent: DEFAULT_DYNAMIC_ISLAND_PREFERENCE.heightPercent,
    });
  }

  return (
    <>
      <SettingsSection title={i18n.t("settings.notch.title")}>
        <ItemGroup class="settings-modal-card">
          <SwitchField
            checked={props.value.macBookNotch}
            onChange={(checked) => props.onUpdateSetting("macBookNotch", checked)}
            label={i18n.t("settings.notch.show.title")}
            description={i18n.t("settings.notch.show.description")}
          />
          <SwitchField
            checked={props.value.macBookNotchIdle}
            disabled={!props.value.macBookNotch}
            onChange={(checked) => props.onUpdateSetting("macBookNotchIdle", checked)}
            label={i18n.t("settings.notch.idle.title")}
            description={i18n.t("settings.notch.idle.description")}
          />
          <SwitchField
            checked={props.value.macBookNotchAdditionalDisplays}
            disabled={!props.value.macBookNotch}
            onChange={(checked) => props.onUpdateSetting("macBookNotchAdditionalDisplays", checked)}
            label={i18n.t("settings.notch.displays.title")}
            description={i18n.t("settings.notch.displays.description")}
          />
          <SwitchField
            checked={props.value.macBookNotchHaptics}
            disabled={!props.value.macBookNotch}
            onChange={(checked) => props.onUpdateSetting("macBookNotchHaptics", checked)}
            label={i18n.t("settings.notch.haptics.title")}
            description={i18n.t("settings.notch.haptics.description")}
          />
        </ItemGroup>
      </SettingsSection>

      <SettingsSection
        title={i18n.t("settings.notch.size.title")}
        description={i18n.t("settings.notch.size.description")}
        actions={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!props.value.macBookNotch || isDefaultSize()}
            onClick={resetSize}
          >
            {i18n.t("settings.notch.size.reset")}
          </Button>
        }
      >
        <ItemGroup class="settings-modal-card settings-dynamic-island-size">
          <div class="settings-dynamic-island-preview">
            <figure class="settings-dynamic-island-preview-display">
              <PreviewFit>
                <OpenBotDynamicIsland
                  presentation={IDLE_DYNAMIC_ISLAND_PRESENTATION}
                  state="compact"
                  displayMode="notch"
                  notchSize={builtInNotchSize()}
                  variant={props.variant}
                  widthPercent={widthPercent()}
                  heightPercent={heightPercent()}
                  onStateChange={() => undefined}
                  onAction={() => undefined}
                />
              </PreviewFit>
              <figcaption class="settings-dynamic-island-preview-caption">
                {i18n.t("settings.notch.size.previewNotch")}
              </figcaption>
            </figure>
            <figure class="settings-dynamic-island-preview-display">
              <PreviewFit>
                <OpenBotDynamicIsland
                  presentation={IDLE_DYNAMIC_ISLAND_PRESENTATION}
                  state="compact"
                  displayMode="island"
                  variant={props.variant}
                  widthPercent={widthPercent()}
                  heightPercent={heightPercent()}
                  onStateChange={() => undefined}
                  onAction={() => undefined}
                />
              </PreviewFit>
              <figcaption class="settings-dynamic-island-preview-caption">
                {i18n.t("settings.notch.size.previewIsland")}
              </figcaption>
            </figure>
          </div>
          <SliderField
            label={i18n.t("settings.notch.size.width")}
            value={widthPercent()}
            minValue={DYNAMIC_ISLAND_SIZE_LIMITS.widthPercent.min}
            maxValue={DYNAMIC_ISLAND_SIZE_LIMITS.widthPercent.max}
            step={DYNAMIC_ISLAND_SIZE_LIMITS.widthPercent.step}
            disabled={!props.value.macBookNotch}
            formatValue={(value) => `${value}%`}
            onChange={(value) => props.onUpdateSetting("macBookNotchWidthPercent", value)}
          />
          <SliderField
            label={i18n.t("settings.notch.size.height")}
            value={heightPercent()}
            minValue={DYNAMIC_ISLAND_SIZE_LIMITS.heightPercent.min}
            maxValue={DYNAMIC_ISLAND_SIZE_LIMITS.heightPercent.max}
            step={DYNAMIC_ISLAND_SIZE_LIMITS.heightPercent.step}
            disabled={!props.value.macBookNotch}
            formatValue={(value) => `${value}%`}
            onChange={(value) => props.onUpdateSetting("macBookNotchHeightPercent", value)}
          />
        </ItemGroup>
      </SettingsSection>
    </>
  );
}

/**
 * A preview frame. An island wider than the frame, such as the built-in island with no notch at
 * 130%, scales down to fit, so its shape stays true and it stays inside the frame.
 */
function PreviewFit(props: { children: JSX.Element }): JSX.Element {
  let frame: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(1);
  onSettled(() => {
    const root = frame;
    if (!root) return;
    // The island inside can mount again, so each measure finds the current one and observes it.
    let observed: HTMLElement | undefined;
    const measure = () => {
      const island = root.querySelector<HTMLElement>(".dynamic-island-size-target") ?? undefined;
      if (island !== observed) {
        if (observed) resize.unobserve(observed);
        if (island) resize.observe(island);
        observed = island;
      }
      const available = root.clientWidth - PREVIEW_FIT_INSET * 2;
      const width = island?.offsetWidth ?? 0;
      setScale(width > available && available > 0 ? available / width : 1);
    };
    const resize = new ResizeObserver(measure);
    const mounts = new MutationObserver(measure);
    resize.observe(root);
    mounts.observe(root, { childList: true, subtree: true });
    measure();
    return () => {
      resize.disconnect();
      mounts.disconnect();
    };
  });
  return (
    <div ref={frame} class="settings-dynamic-island-preview-bar" inert>
      <div class="settings-dynamic-island-preview-fit" style={{ "--settings-dynamic-island-preview-scale": scale() }}>
        {props.children}
      </div>
    </div>
  );
}
