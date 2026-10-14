import type {
  AuthenticatedSessionView,
  InvitationPreview,
  InvitationUnusableReason,
  SsoProviderView,
} from "@deskmates/contracts";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { AuthClient } from "../api/auth-client.js";
import type { SessionFlows } from "../api/members-client.js";
import { ApiError } from "../api/types.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { PasswordField } from "../features/account/account-settings.js";
import { useT } from "../i18n/i18n-provider.js";
import { startSso } from "./start-sso.js";

/**
 * `#/invite/<token>`. An open sign-up link (`local_signup`, ADR-0022 amendment 4) lets the
 * visitor choose a username and password, or sign in to join with an account they have; a legacy
 * `local_new` invitation asks for a password for its reserved
 * login name; an existing-account invitation is accepted from that account's own session; an SSO
 * invitation continues at the provider. The Gateway decides whether this browser may accept it.
 */
export function InviteScreen({
  flows,
  auth,
  token,
  session,
  loginCsrf,
  onSignedIn,
  onSessionStarted,
  onJoined,
}: {
  flows: SessionFlows;
  /** For "Already have an account? Sign in to join"; without it that option is not offered. */
  auth?: AuthClient;
  token: string;
  session: AuthenticatedSessionView | undefined;
  loginCsrf: string | undefined;
  onSignedIn: (view: AuthenticatedSessionView) => void;
  /** A sign-in made on this page, which stays on the invitation to join with it. */
  onSessionStarted?: (view: AuthenticatedSessionView) => void;
  onJoined: (tenantId: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<InvitationPreview | null>();
  const [unusable, setUnusable] = useState<InvitationUnusableReason>();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: "username" | "password"; text: string }>();
  useEffect(() => {
    let live = true;
    flows
      .previewInvitation(token)
      .then((next) => live && setPreview(next))
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 410)
          setUnusable(unusableReason(err.details.reason));
        setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [flows, token]);
  const clearSecrets = (): void => {
    setPassword("");
    setConfirm("");
  };
  const fail = (err: unknown): void => {
    clearSecrets();
    if (err instanceof ApiError && err.status === 410) {
      setUnusable(unusableReason(err.details.reason));
      setPreview(null);
    } else if (err instanceof ApiError && err.details.reason === "login_name_taken")
      setError({ field: "username", text: t("app.invite.error.taken") });
    else if (err instanceof ApiError && err.details.reason === "sso_required")
      setError({ text: t("members.error.ssoRequired") });
    else if (err instanceof ApiError && err.status === 400) setError({ text: err.message });
    else setError({ text: t("app.invite.error") });
  };
  const accept = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();
    const csrf = session?.csrfToken ?? loginCsrf;
    if (!csrf || busy || !preview) return;
    const kind = preview.target.kind;
    const creating = !session && (kind === "local_signup" || kind === "local_new");
    if (creating) {
      if (kind === "local_signup" && !loginName.trim())
        return setError({ field: "username", text: t("app.invite.error.username") });
      if (!password) return setError({ field: "password", text: t("account.password.error.new") });
      if (password !== confirm)
        return setError({ field: "password", text: t("account.password.error.mismatch") });
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await flows.acceptInvitation(
        !creating
          ? { token }
          : kind === "local_signup"
            ? { token, loginName: loginName.trim(), password }
            : { token, password },
        csrf,
      );
      clearSecrets();
      if ("authenticated" in result) onSignedIn(result);
      else onJoined(result.tenantId);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const signInToJoin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!auth || !loginCsrf || busy || !loginName.trim() || !password) return;
    setBusy(true);
    setError(undefined);
    try {
      const view = await auth.login(loginName.trim(), password, loginCsrf);
      clearSecrets();
      setSigningIn(false);
      onSessionStarted?.(view);
    } catch (err) {
      clearSecrets();
      setError({
        text:
          err instanceof ApiError && err.status === 401
            ? t("app.signIn.error.incorrect")
            : t("app.invite.error"),
      });
    } finally {
      setBusy(false);
    }
  };
  if (preview === undefined)
    return (
      <main className="credential-screen" aria-busy="true">
        <div className="credential-card">
          <p>{t("app.invite.checking")}</p>
        </div>
      </main>
    );
  if (preview === null)
    return (
      <main className="credential-screen">
        <div className="credential-card">
          <p role="alert" className="error">
            {unusable === "used"
              ? t("app.invite.used")
              : unusable === "revoked"
                ? t("app.invite.revoked")
                : unusable === "expired"
                  ? t("app.invite.expired")
                  : t("app.invite.invalid")}
          </p>
          {unusable ? <p>{t("app.invite.askForNew")}</p> : null}
          <a href="#/threads">{t("app.invite.goToSignIn")}</a>
        </div>
      </main>
    );
  const target = preview.target;
  const errorFor = (field: "username" | "password" | undefined) =>
    error && error.field === field ? (
      <p role="alert" className="error" id={`invite-error-${field ?? "form"}`}>
        {error.text}
      </p>
    ) : null;
  if (target.kind === "local_signup" && signingIn && !session)
    return (
      <main className="credential-screen">
        <form className="credential-card" onSubmit={signInToJoin}>
          <h1>{t("app.invite.join", { tenant: preview.tenantName })}</h1>
          <p>{t("app.invite.signInToJoinLead")}</p>
          {errorFor(undefined)}
          <label htmlFor="invite-signin-name">{t("app.signIn.loginName")}</label>
          <Input
            id="invite-signin-name"
            name="username"
            autoComplete="username"
            value={loginName}
            disabled={busy}
            onChange={(event) => setLoginName(event.target.value)}
          />
          <label htmlFor="invite-signin-password">{t("app.signIn.password")}</label>
          <Input
            id="invite-signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button
            variant="default"
            type="submit"
            disabled={busy || !loginCsrf || loginName.trim() === "" || password === ""}
          >
            {t("app.signIn.submit")}
          </Button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSigningIn(false);
              setError(undefined);
              clearSecrets();
            }}
          >
            {t("app.invite.backToCreate")}
          </button>
        </form>
      </main>
    );
  return (
    <main className="credential-screen">
      <form className="credential-card" onSubmit={accept} noValidate>
        <h1>{t("app.invite.join", { tenant: preview.tenantName })}</h1>
        <p>
          {target.kind === "oidc_email"
            ? t("app.invite.forEmail", { role: preview.role, email: target.email })
            : target.kind === "local_signup"
              ? t("app.invite.forAnyone", { role: preview.role, tenant: preview.tenantName })
              : t("app.invite.forLoginName", { role: preview.role, loginName: target.loginName })}
        </p>
        {preview.expiresAt ? (
          <small>
            {t("app.invite.expiresAt", {
              when: new Date(preview.expiresAt).toLocaleString(),
            })}
          </small>
        ) : null}
        {errorFor(undefined)}
        {target.kind === "local_signup" ? (
          session ? (
            <>
              <Button variant="default" type="submit" disabled={busy}>
                {t("app.invite.joinAs", { name: session.user.displayName })}
              </Button>
              <small>{t("app.invite.signOutForSeparate")}</small>
            </>
          ) : (
            <>
              <label htmlFor="invite-username">{t("app.invite.username")}</label>
              <Input
                id="invite-username"
                name="username"
                autoComplete="username"
                spellCheck={false}
                value={loginName}
                disabled={busy}
                aria-invalid={error?.field === "username" ? true : undefined}
                onChange={(event) => setLoginName(event.target.value)}
              />
              {errorFor("username")}
              <small>{t("app.invite.usernameHint")}</small>
              <PasswordField
                id="invite-password"
                label={t("app.invite.choosePassword")}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                disabled={busy}
                invalid={error?.field === "password"}
              />
              <PasswordField
                id="invite-password-confirm"
                label={t("account.password.confirm")}
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                disabled={busy}
                invalid={error?.field === "password"}
              />
              {errorFor("password")}
              <Button variant="default" type="submit" disabled={busy || !loginCsrf}>
                {t("app.invite.createAndJoin")}
              </Button>
              {auth ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setSigningIn(true);
                    setError(undefined);
                    clearSecrets();
                    setLoginName("");
                  }}
                >
                  {t("app.invite.signInToJoin")}
                </button>
              ) : null}
            </>
          )
        ) : target.kind === "local_new" ? (
          <>
            <PasswordField
              id="invite-password"
              label={t("app.invite.choosePassword")}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              disabled={busy}
              invalid={error?.field === "password"}
            />
            <PasswordField
              id="invite-password-confirm"
              label={t("account.password.confirm")}
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              disabled={busy}
              invalid={error?.field === "password"}
            />
            {errorFor("password")}
            <Button
              variant="default"
              type="submit"
              disabled={busy || !loginCsrf || password === ""}
            >
              {t("app.invite.createAndJoin")}
            </Button>
            {!loginCsrf ? <small>{t("app.invite.signOutToCreate")}</small> : null}
          </>
        ) : target.kind === "local_user" ? (
          session ? (
            <Button variant="default" type="submit" disabled={busy}>
              {t("app.invite.joinAs", { name: session.user.displayName })}
            </Button>
          ) : (
            <p>
              {t.rich("app.invite.signInFirst", {
                loginName: target.loginName,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}{" "}
              <a href="#/threads">{t("app.invite.signIn")}</a>
            </p>
          )
        ) : preview.provider && loginCsrf ? (
          <Button
            variant="default"
            type="button"
            disabled={busy}
            onClick={() =>
              void startSso(
                flows,
                preview.provider as SsoProviderView,
                { purpose: "login", invitation: token },
                loginCsrf,
                (text) => setError({ text }),
              )
            }
          >
            {t("app.invite.continueWith", { provider: preview.provider.displayName })}
          </Button>
        ) : (
          <p>{t("app.invite.signOutForSso")}</p>
        )}
      </form>
    </main>
  );
}

function unusableReason(reason: unknown): InvitationUnusableReason | undefined {
  return reason === "used" || reason === "revoked" || reason === "expired" ? reason : undefined;
}
