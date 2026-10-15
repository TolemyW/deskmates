// Opening a published app (ADR-0035 decision 3): ask the Gateway for a one-use ticket, then post
// it to the app's own origin in a form. The ticket never appears in an address, so it stays out
// of history, logs and referrers; the app origin answers with its own cookie and the app.

import type { AppShareOpenResponse } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";

export interface AppOpenScreenProps {
  api: Pick<ApiClient, "openAppShare">;
  workspaceId: string;
  shareId: string;
  path?: string;
  /** Submits the entry form; tests replace the browser's navigation. */
  submit?: (form: HTMLFormElement) => void;
}

export function AppOpenScreen({
  api,
  workspaceId,
  shareId,
  path,
  submit = (form) => form.submit(),
}: AppOpenScreenProps) {
  const t = useT();
  const form = useRef<HTMLFormElement>(null);
  const [entry, setEntry] = useState<AppShareOpenResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setEntry(undefined);
    setError(undefined);
    api.openAppShare(workspaceId, shareId, path).then(
      (opened) => live && setEntry(opened),
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, shareId, path]);
  useEffect(() => {
    if (entry && form.current) submit(form.current);
  }, [entry, submit]);
  return (
    <section className="card app-open" aria-live="polite">
      <h2>{t("appShares.open.title")}</h2>
      {error ? (
        <p role="alert">{t("appShares.open.failed", { error })}</p>
      ) : (
        <p>{t("appShares.open.opening")}</p>
      )}
      {entry ? (
        <form ref={form} method="post" action={entry.enterUrl}>
          <input type="hidden" name="ticket" value={entry.ticket} />
          <button type="submit">{t("appShares.open.continue")}</button>
        </form>
      ) : null}
    </section>
  );
}
