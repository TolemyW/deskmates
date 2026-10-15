// A workspace's published apps (ADR-0035, owner-decided 2026-10-14): each app's state and
// address, Open (a new tab through the entry page), Stop sharing, and a form to share a running
// port. Every Member may publish and stop; Guests never reach it. Used by the Files page and the
// workspace detail page; the Gateway decides, and a refusal shows its message.

import type { AppShare } from "@deskmates/contracts";
import { Input } from "@deskmates/ui";
import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { AppShareList, AppSharesApi } from "./api.js";
import { appOpenHref } from "./route.js";

const STATE_KEY = {
  available: "appShares.state.available",
  unavailable: "appShares.state.unavailable",
  revoked: "appShares.state.revoked",
} as const;

export function AppSharesPanel({
  api,
  workspaceId,
  onList,
}: {
  api: AppSharesApi;
  workspaceId: string;
  /** Told every list the panel shows, for a count beside an entry button. */
  onList?: (list: AppShareList) => void;
}) {
  const t = useT();
  const [list, setList] = useState<AppShareList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");

  const show = useCallback(
    (next: AppShareList) => {
      setList(next);
      onList?.(next);
    },
    [onList],
  );
  const load = useCallback(() => {
    setError(undefined);
    // Through a promise, so a client without this domain (a partial test double) is an error line,
    // not a broken page.
    Promise.resolve()
      .then(() => api.listAppShares(workspaceId))
      .then(show, (err: unknown) => setError(errorMessage(err)));
  }, [api, workspaceId, show]);
  useEffect(() => load(), [load]);

  const stop = async (share: AppShare) => {
    if (!window.confirm(t("appShares.stopConfirm", { label: share.label }))) return;
    setBusy(share.id);
    setError(undefined);
    try {
      const revoked = await api.revokeAppShare(workspaceId, share.id);
      if (list)
        show({ ...list, shares: list.shares.map((s) => (s.id === revoked.id ? revoked : s)) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };

  const publish = async () => {
    setBusy("publish");
    setError(undefined);
    try {
      const { share } = await api.publishAppShare(workspaceId, Number(port), label.trim());
      const others = (list?.shares ?? []).filter((s) => s.id !== share.id);
      show({ enabled: true, shares: [share, ...others] });
      setPort("");
      setLabel("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };

  const shares = list?.shares ?? [];
  const portValid = /^\d{4,5}$/.test(port.trim());
  return (
    <div className="app-shares-panel">
      {error ? <p className="error">{error}</p> : null}
      {list === undefined && !error ? <p>{t("appShares.loading")}</p> : null}
      {list && !list.enabled ? <p>{t("appShares.disabled")}</p> : null}
      {list?.enabled && shares.length === 0 ? <p>{t("appShares.empty")}</p> : null}
      {shares.length > 0 ? (
        <ul className="app-share-list">
          {shares.map((share) => (
            <li key={share.id} className="app-share-row" data-state={share.state}>
              <div>
                <strong>{share.label}</strong>{" "}
                <span className="muted">
                  {t("appShares.port", { port: share.port })} · {t(STATE_KEY[share.state])}
                  {share.publishedBy ? ` · ${t("appShares.byPerson")}` : ""}
                </span>
                {share.state !== "revoked" ? (
                  <div className="app-share-url">
                    <code>{share.url}</code>
                  </div>
                ) : null}
                {share.state === "unavailable" ? (
                  <div className="muted">{t("appShares.unavailableHint")}</div>
                ) : null}
              </div>
              {share.state !== "revoked" ? (
                <div className="form-actions">
                  <ButtonLink
                    variant="outline"
                    href={appOpenHref(workspaceId, share.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("appShares.openApp")}
                  </ButtonLink>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy === share.id}
                    onClick={() => void stop(share)}
                  >
                    {t("appShares.stop")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {list?.enabled ? (
        <form
          className="app-share-publish"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <p className="muted">{t("appShares.publishIntro")}</p>
          <Input
            aria-label={t("appShares.publishPort")}
            placeholder={t("appShares.publishPortPlaceholder")}
            inputMode="numeric"
            value={port}
            maxLength={5}
            onChange={(event) => setPort(event.currentTarget.value)}
          />
          <Input
            aria-label={t("appShares.publishLabel")}
            placeholder={t("appShares.publishLabel")}
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <div className="form-actions">
            <Button
              type="submit"
              disabled={busy === "publish" || !portValid || label.trim() === ""}
            >
              {t("appShares.publish")}
            </Button>
            <Button type="button" variant="outline" onClick={load}>
              {t("appShares.refresh")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
