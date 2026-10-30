import type { AnonymousSessionView, AuthenticatedSessionView } from "@deskmates/contracts";
import { BrandMark } from "@deskmates/ui";
import type { FormEvent } from "react";
import { useState } from "react";
import type { AuthClient } from "../api/auth-client.js";
import type { SessionFlows } from "../api/members-client.js";
import { ApiError } from "../api/types.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useT } from "../i18n/i18n-provider.js";
import { startSso } from "./start-sso.js";

export function SignInScreen({
  flows,
  auth,
  view,
  notice,
  onSignedIn,
  onStale,
}: {
  flows: SessionFlows;
  auth: AuthClient;
  view: AnonymousSessionView;
  notice: string | undefined;
  onSignedIn: (view: AuthenticatedSessionView) => void;
  /** The pre-login token expired; fetch a fresh one. */
  onStale: () => void;
}) {
  const t = useT();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!loginName.trim() || !password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const signedIn = await auth.login(loginName.trim(), password, view.loginCsrf);
      setPassword("");
      onSignedIn(signedIn);
    } catch (err) {
      setPassword("");
      if (err instanceof ApiError && err.status === 401) {
        setError(t("app.signIn.error.incorrect"));
      } else if (err instanceof ApiError && err.status === 429) {
        const seconds = Number(err.details.retryAfterSeconds);
        const minutes = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds / 60)) : 15;
        setError(t("app.signIn.error.tooMany", { minutes }));
      } else if (err instanceof ApiError && err.status === 403) {
        setError(t("app.signIn.error.expired"));
        onStale();
      } else {
        setError(t("app.gateway.unreachable"));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="credential-screen">
      <form className="credential-card" onSubmit={submit}>
        <div className="credential-brand">
          <span className="brand-mark">
            <BrandMark size={24} />
          </span>{" "}
          Deskmates
        </div>
        <span className="eyebrow">{t("app.signIn.eyebrow")}</span>
        <h1>
          {t("app.signIn.headlineFirst")}
          <br />
          {t("app.signIn.headlineSecond")}
        </h1>
        <p>{t("app.signIn.lead")}</p>
        {error || notice ? (
          <p role="alert" className="error">
            {error ?? notice}
          </p>
        ) : null}
        {view.setupRequired ? (
          <p className="setup-required">
            {t.rich("app.signIn.setupRequired", {
              command: "auth-cli bootstrap-owner",
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        ) : null}
        <label htmlFor="login-name">{t("app.signIn.loginName")}</label>
        <Input
          id="login-name"
          name="username"
          autoComplete="username"
          disabled={busy}
          value={loginName}
          onChange={(event) => setLoginName(event.target.value)}
        />
        <label htmlFor="login-password">{t("app.signIn.password")}</label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button
          variant="default"
          type="submit"
          disabled={busy || loginName.trim() === "" || password === ""}
        >
          {busy ? t("app.signIn.submitting") : t("app.signIn.submit")}
        </Button>
        {(view.ssoProviders ?? []).length > 0 ? (
          <div className="sso-providers" aria-label={t("app.signIn.singleSignOn")}>
            {(view.ssoProviders ?? []).map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  setBusy(true);
                  setError(undefined);
                  void startSso(
                    flows,
                    provider,
                    { purpose: "login" },
                    view.loginCsrf,
                    (message) => {
                      setError(message);
                      setBusy(false);
                    },
                  );
                }}
              >
                {t("app.signIn.withProvider", { provider: provider.displayName })}
              </Button>
            ))}
          </div>
        ) : null}
        <small>{t("app.signIn.staySignedIn")}</small>
      </form>
    </main>
  );
}
