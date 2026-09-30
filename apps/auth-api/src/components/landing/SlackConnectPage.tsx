import { AppLogo } from "@openbot/brand";
import { createSignal, onSettled, Show } from "solid-js";
import { Button } from "../ui/button";

/**
 * The page that returns a Slack sign-in to the desktop app. Slack redirects here after an agent's
 * app is installed (`?code&state`), and the manager app's callback redirects here with a sealed
 * grant in the fragment. The page only builds the `openbot://` link: the code is useless without
 * the app's client secret on the host, and only the host can open the grant.
 */
export function SlackConnectPage() {
  const [openUrl, setOpenUrl] = createSignal("");
  const [failed, setFailed] = createSignal(false);

  onSettled(() => {
    const page = new URL(window.location.href);
    const fragment = new URLSearchParams(page.hash.slice(1));
    const target = slackDeepLink(page.searchParams, fragment);
    // The code and the grant are no use to anyone who reads the address bar later.
    window.history.replaceState(null, "", page.pathname);
    if (!target) {
      setFailed(true);
      return;
    }
    setOpenUrl(target);
    window.location.assign(target);
  });

  return (
    <main class="join-page">
      <a class="landing-brand join-page-brand" href="/" aria-label="OpenBot home">
        <AppLogo variant="production" class="landing-brand-logo" />
        <span>OpenBot</span>
      </a>
      <section class="join-card" aria-labelledby="slack-connect-title">
        <AppLogo variant="production" animation="blink" class="join-card-logo" />
        <p class="join-card-eyebrow">Slack</p>
        <h1 id="slack-connect-title">Return to OpenBot</h1>
        <Show
          when={!failed()}
          fallback={
            <p class="join-card-error">Slack did not finish the connection. Go back to OpenBot and start again.</p>
          }
        >
          <p class="join-card-copy">OpenBot finishes the Slack connection on your computer.</p>
          <Show when={openUrl()}>
            {(href) => (
              <div class="join-card-actions">
                <Button href={href()} variant="primary" size="lg" icon="open">
                  Open OpenBot
                </Button>
              </div>
            )}
          </Show>
        </Show>
      </section>
    </main>
  );
}

function slackDeepLink(query: URLSearchParams, fragment: URLSearchParams): string | null {
  const nonce = fragment.get("nonce");
  const grant = fragment.get("grant");
  if (nonce && grant) return `openbot://slack-workspace?${new URLSearchParams({ nonce, grant })}`;
  const code = query.get("code");
  const state = query.get("state");
  if (code && state) return `openbot://slack-install?${new URLSearchParams({ code, state })}`;
  return null;
}
