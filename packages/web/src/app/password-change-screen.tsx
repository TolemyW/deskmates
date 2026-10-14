// The forced password change (ADR-0022 amendment 6 W2, ADR-0031 decision 8). While the session
// reports `passwordChangeRequired` (the protected root `admin` still on its default password),
// every `/api` route answers 403, so the app shows only this screen: no shell, no stream, no
// `/api` request. `POST /auth/password` rotates the session; the app then reads it again.

import type { AuthenticatedSessionView } from "@deskmates/contracts";
import { BrandMark } from "@deskmates/ui";
import { type FormEvent, useMemo, useState } from "react";
import { createAccountClient } from "../api/account-client.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { errorMessage } from "../format.js";
import { useT } from "../i18n/i18n-provider.js";

export function PasswordChangeScreen({
  session,
  onChanged,
  onSignOut,
}: {
  session: AuthenticatedSessionView;
  /** The password changed; read the session again. */
  onChanged: () => void;
  onSignOut: () => void;
}) {
  const t = useT();
  const account = useMemo(
    () =>
      createAccountClient({
        csrfToken: () => session.csrfToken,
        tenantId: session.tenant.id,
      }),
    [session.csrfToken, session.tenant.id],
  );
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || !current || !next) return;
    if (next !== confirm) return setError(t("app.passwordChange.mismatch"));
    if (next === current) return setError(t("app.passwordChange.same"));
    setBusy(true);
    setError(undefined);
    try {
      await account.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <main className="credential-screen">
      <form
        className="credential-card"
        onSubmit={submit}
        aria-labelledby="password-change-title"
        data-testid="password-change"
      >
        <div className="credential-brand">
          <span className="brand-mark">
            <BrandMark size={24} />
          </span>{" "}
          Deskmates
        </div>
        <h1 id="password-change-title">{t("app.passwordChange.title")}</h1>
        <p>{t("app.passwordChange.intro")}</p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={session.user.loginName ?? ""}
          readOnly
          hidden
        />
        <label htmlFor="password-current">{t("app.passwordChange.current")}</label>
        <Input
          id="password-current"
          type="password"
          autoComplete="current-password"
          disabled={busy}
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <label htmlFor="password-new">{t("app.passwordChange.new")}</label>
        <Input
          id="password-new"
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <label htmlFor="password-confirm">{t("app.passwordChange.confirm")}</label>
        <Input
          id="password-confirm"
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <Button
          variant="default"
          type="submit"
          disabled={busy || current === "" || next === "" || confirm === ""}
        >
          {busy ? t("app.passwordChange.working") : t("app.passwordChange.submit")}
        </Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={onSignOut}>
          {t("app.passwordChange.signOut")}
        </Button>
      </form>
    </main>
  );
}
