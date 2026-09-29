import type { MessagingConnection, MessagingOverview, MessagingThread } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  Input,
  SettingsSection,
  Text,
} from "@openbot/ui";
import { SettingsField, SettingsPanelHeader } from "@openbot/ui/components/SettingsPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, For, Show } from "solid-js";
import type { MessagingPort } from "./messaging-port";

/** How often the status is read while the view is open: a connection changes state on its own. */
const STATUS_POLL_MS = 3_000;

export const MESSAGING_STATE_LABEL = {
  connecting: "messaging.state.connecting",
  connected: "messaging.state.connected",
  reconnecting: "messaging.state.reconnecting",
  paused: "messaging.state.paused",
  invalid_token: "messaging.state.invalid_token",
  missing_scope: "messaging.state.missing_scope",
  tokens_mismatch: "messaging.state.tokens_mismatch",
  rate_limited: "messaging.state.rate_limited",
  socket_mode_off: "messaging.state.socket_mode_off",
  secret_storage_unavailable: "messaging.state.secret_storage_unavailable",
  error: "messaging.state.error",
} as const satisfies Record<MessagingConnection["state"], AppTextKey>;

const STATE_HELP: Partial<Record<MessagingConnection["state"], AppTextKey>> = {
  invalid_token: "messaging.help.invalid_token",
  tokens_mismatch: "messaging.help.tokens_mismatch",
  socket_mode_off: "messaging.help.socket_mode_off",
  secret_storage_unavailable: "messaging.help.secret_storage_unavailable",
};

function stateVariant(state: MessagingConnection["state"]) {
  if (state === "connected") return "success-light" as const;
  if (state === "connecting" || state === "reconnecting" || state === "paused") return "secondary" as const;
  if (state === "rate_limited" || state === "missing_scope") return "warning-light" as const;
  return "destructive-light" as const;
}

interface SlackSettingsState {
  overview: MessagingOverview | null;
  loadError: string | null;
  actionError: string | null;
  pending: boolean;
  /** The tokens being typed. They are cleared after each connect and are never read back. */
  botToken: string;
  appToken: string;
  copied: boolean;
  confirmDisconnect: boolean;
  /** The conversation open in the transcript view. */
  thread: MessagingThread | null;
  threadError: string | null;
}

export interface AgentSlackSettingsProps {
  port: MessagingPort;
  agentId: string;
  agentName: string;
  onBack: () => void;
  onClose: () => void;
  /** The state the Slack row of the agent settings shows. */
  onStateChange?: (connection: MessagingConnection | null) => void;
}

/**
 * Agent settings > Slack. Connects the agent to a Slack app that the user creates from a manifest,
 * shows the connection, and lists the Slack conversations the agent answers. Tokens go to the host
 * and never come back.
 */
export function AgentSlackSettings(props: AgentSlackSettingsProps) {
  const { t, format, errorMessage } = useText();
  const [state, setState] = createStore<SlackSettingsState>({
    overview: null,
    loadError: null,
    actionError: null,
    pending: false,
    botToken: "",
    appToken: "",
    copied: false,
    confirmDisconnect: false,
    thread: null,
    threadError: null,
  });
  const connection = () => state.overview?.connection ?? null;
  const connected = () => connection()?.credentials === "saved";

  async function load(): Promise<void> {
    try {
      const overview = await props.port.api.getOverview({ agentId: props.agentId }, props.port.serverId);
      setState((draft) => {
        draft.overview = overview;
        draft.loadError = null;
      });
      props.onStateChange?.(overview.connection);
    } catch (error) {
      setState((draft) => {
        draft.loadError = errorMessage(error, t("messaging.slack.loadFailed"));
      });
    }
  }

  createEffect(
    () => props.agentId,
    () => {
      void load();
      const timer = setInterval(() => void load(), STATUS_POLL_MS);
      return () => clearInterval(timer);
    },
  );

  async function act(run: () => Promise<MessagingOverview>): Promise<void> {
    setState((draft) => {
      draft.pending = true;
      draft.actionError = null;
    });
    try {
      const overview = await run();
      setState((draft) => {
        draft.overview = overview;
        draft.botToken = "";
        draft.appToken = "";
        draft.confirmDisconnect = false;
      });
      props.onStateChange?.(overview.connection);
    } catch (error) {
      setState((draft) => {
        draft.actionError = errorMessage(error, t("messaging.slack.loadFailed"));
      });
    } finally {
      setState((draft) => {
        draft.pending = false;
      });
    }
  }

  const scoped = { agentId: () => props.agentId, server: () => props.port.serverId };
  const connect = () =>
    act(() =>
      props.port.api.connectSlack(
        { agentId: scoped.agentId(), botToken: state.botToken, appToken: state.appToken },
        scoped.server(),
      ),
    );

  async function setup(action: "open" | "copy"): Promise<void> {
    try {
      const setupValue = await props.port.api.getSlackSetup({ agentId: props.agentId }, props.port.serverId);
      if (action === "open") await props.port.openUrl(setupValue.createAppUrl);
      else {
        await props.port.copyText(setupValue.manifestJson);
        setState((draft) => {
          draft.copied = true;
        });
      }
    } catch (error) {
      setState((draft) => {
        draft.actionError = errorMessage(error, t("messaging.slack.loadFailed"));
      });
    }
  }

  async function openThread(linkId: string): Promise<void> {
    try {
      const thread = await props.port.api.readThread({ agentId: props.agentId, linkId }, props.port.serverId);
      setState((draft) => {
        draft.thread = thread;
        draft.threadError = null;
      });
    } catch (error) {
      setState((draft) => {
        draft.threadError = errorMessage(error, t("messaging.slack.thread.loadFailed"));
      });
    }
  }

  return (
    <div class="agent-slack-settings">
      <Show
        when={state.thread}
        fallback={
          <SettingsPanelHeader
            title={t("messaging.slack.title")}
            onBack={props.onBack}
            backLabel={t("messaging.slack.back")}
            onClose={props.onClose}
            closeLabel={t("messaging.slack.close")}
          />
        }
      >
        {(thread) => (
          <SettingsPanelHeader
            title={thread().title}
            onBack={() =>
              setState((draft) => {
                draft.thread = null;
              })
            }
            backLabel={t("messaging.slack.thread.back")}
            onClose={props.onClose}
            closeLabel={t("messaging.slack.close")}
          />
        )}
      </Show>
      <div class="agent-slack-body">
        <Show
          when={state.thread}
          fallback={
            <>
              <Text variant="body-sm" tone="secondary">
                {t("messaging.slack.intro", { name: props.agentName })}
              </Text>
              <Show when={state.loadError}>
                {(message) => (
                  <Alert tone="danger">
                    <AlertContent>
                      <AlertDescription>{message()}</AlertDescription>
                    </AlertContent>
                  </Alert>
                )}
              </Show>
              <Show when={state.actionError}>
                {(message) => (
                  <Alert tone="danger" role="alert">
                    <AlertContent>
                      <AlertDescription>{message()}</AlertDescription>
                    </AlertContent>
                  </Alert>
                )}
              </Show>
              <Show
                when={connected() && connection()}
                fallback={
                  <SettingsSection title={t("messaging.slack.setup.title")}>
                    <ol class="agent-slack-steps">
                      <li>
                        <Text variant="body-sm">{t("messaging.slack.setup.create", { name: props.agentName })}</Text>
                        <div class="agent-slack-actions">
                          <Button size="sm" onClick={() => void setup("open")}>
                            {t("messaging.slack.setup.createButton")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void setup("copy")}>
                            {state.copied
                              ? t("messaging.slack.setup.manifestCopied")
                              : t("messaging.slack.setup.copyManifest")}
                          </Button>
                        </div>
                      </li>
                      <li>
                        <Text variant="body-sm">{t("messaging.slack.setup.install")}</Text>
                      </li>
                      <li>
                        <Text variant="body-sm">{t("messaging.slack.setup.appToken")}</Text>
                      </li>
                      <li>
                        <Text variant="body-sm">{t("messaging.slack.setup.invite", { name: props.agentName })}</Text>
                      </li>
                    </ol>
                    <form
                      class="agent-slack-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void connect();
                      }}
                    >
                      <SettingsField label={t("messaging.slack.setup.botToken")}>
                        <Input
                          type="password"
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={t("messaging.slack.setup.botTokenPlaceholder")}
                          value={state.botToken}
                          onValueChange={(value) =>
                            setState((draft) => {
                              draft.botToken = value;
                            })
                          }
                        />
                      </SettingsField>
                      <SettingsField label={t("messaging.slack.setup.appTokenLabel")}>
                        <Input
                          type="password"
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={t("messaging.slack.setup.appTokenPlaceholder")}
                          value={state.appToken}
                          onValueChange={(value) =>
                            setState((draft) => {
                              draft.appToken = value;
                            })
                          }
                        />
                      </SettingsField>
                      <Button
                        type="submit"
                        disabled={!state.botToken.trim() || !state.appToken.trim()}
                        loading={state.pending}
                        loadingLabel={t("messaging.slack.setup.connecting")}
                      >
                        {t("messaging.slack.setup.connect")}
                      </Button>
                    </form>
                  </SettingsSection>
                }
              >
                {(current) => (
                  <SettingsSection
                    title={t("messaging.slack.status.title")}
                    actions={
                      <Badge variant={stateVariant(current().state)}>{t(MESSAGING_STATE_LABEL[current().state])}</Badge>
                    }
                  >
                    <Show when={current().workspaceName}>
                      {(name) => (
                        <Text variant="body-sm">
                          {t("messaging.slack.status.workspace")}: {name()}
                        </Text>
                      )}
                    </Show>
                    <Show when={STATE_HELP[current().state]}>
                      {(key) => (
                        <Alert tone="danger">
                          <AlertContent>
                            <AlertDescription>{t(key())}</AlertDescription>
                          </AlertContent>
                        </Alert>
                      )}
                    </Show>
                    <Show when={current().missingScopes.length > 0}>
                      <Alert tone="warning">
                        <AlertContent>
                          <AlertDescription>
                            {t("messaging.slack.status.missingScopes", {
                              scopes: format.list(current().missingScopes),
                            })}
                          </AlertDescription>
                        </AlertContent>
                      </Alert>
                    </Show>
                    <Show when={current().retryAt}>
                      {(retryAt) => (
                        <Text variant="caption" tone="muted">
                          {t("messaging.slack.status.retryAt", {
                            time: format.date(new Date(retryAt()), { hour: "numeric", minute: "2-digit" }),
                          })}
                        </Text>
                      )}
                    </Show>
                    <div class="agent-slack-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={state.pending}
                        onClick={() =>
                          void act(() => props.port.api.reconnect({ agentId: scoped.agentId() }, scoped.server()))
                        }
                      >
                        {t("messaging.slack.status.reconnect")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={state.pending}
                        onClick={() =>
                          void act(() =>
                            props.port.api.setEnabled(
                              { agentId: scoped.agentId(), enabled: !current().enabled },
                              scoped.server(),
                            ),
                          )
                        }
                      >
                        {current().enabled ? t("messaging.slack.status.pause") : t("messaging.slack.status.resume")}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive-ghost"
                        disabled={state.pending}
                        onClick={() =>
                          setState((draft) => {
                            draft.confirmDisconnect = true;
                          })
                        }
                      >
                        {t("messaging.slack.status.disconnect")}
                      </Button>
                    </div>
                  </SettingsSection>
                )}
              </Show>
              <Alert tone="warning">
                <AlertContent>
                  <AlertDescription>{t("messaging.slack.warning", { name: props.agentName })}</AlertDescription>
                </AlertContent>
              </Alert>
              <SettingsSection title={t("messaging.slack.threads.title")}>
                <Show when={state.threadError}>
                  {(message) => (
                    <Text variant="caption" tone="danger" role="alert">
                      {message()}
                    </Text>
                  )}
                </Show>
                <Show
                  when={(state.overview?.threads.length ?? 0) > 0}
                  fallback={
                    <Text variant="body-sm" tone="muted">
                      {t("messaging.slack.threads.empty", { name: props.agentName })}
                    </Text>
                  }
                >
                  <ul class="agent-slack-threads">
                    <For each={state.overview?.threads ?? []} keyed={(thread) => thread.linkId}>
                      {(thread) => (
                        <li>
                          <Button
                            variant="ghost"
                            class="agent-slack-thread"
                            onClick={() => void openThread(thread().linkId)}
                          >
                            <span class="agent-slack-thread-title">
                              {thread().isDirect
                                ? t("messaging.slack.threads.direct", { name: thread().title })
                                : thread().title}
                            </span>
                            <span class="agent-slack-thread-time">
                              {format.date(new Date(thread().updatedAt), { dateStyle: "medium", timeStyle: "short" })}
                            </span>
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </SettingsSection>
            </>
          }
        >
          {(thread) => (
            <ol class="agent-slack-transcript">
              <For each={thread().messages} keyed={(message) => message.id}>
                {(message) => (
                  <li class="agent-slack-message" data-role={message().role}>
                    <Text variant="label-sm">
                      {message().role === "agent" ? props.agentName : (message().authorName ?? "")}
                    </Text>
                    <Text variant="body-sm" class="agent-slack-message-text">
                      {message().text}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {format.date(new Date(message().createdAt), { timeStyle: "short" })}
                    </Text>
                  </li>
                )}
              </For>
            </ol>
          )}
        </Show>
      </div>
      <ConfirmDialog
        open={state.confirmDisconnect}
        tone="destructive"
        title={t("messaging.slack.status.disconnectTitle")}
        description={t("messaging.slack.status.disconnectDescription")}
        confirmLabel={t("messaging.slack.status.disconnect")}
        pending={state.pending}
        onCancel={() =>
          setState((draft) => {
            draft.confirmDisconnect = false;
          })
        }
        onConfirm={() => act(() => props.port.api.disconnect({ agentId: scoped.agentId() }, scoped.server()))}
      />
    </div>
  );
}
