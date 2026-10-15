// Detail › Apps (ADR-0035): what bots published in this workspace, whether each answers now, its
// address, Open (a new tab through the entry page) and, for Owners and Admins, Stop sharing.
// Opening this section probes each active app once; nothing changes until someone stops one.

import { type AppShare, workspaceRoleAtLeast } from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";
import type { AppShareList } from "./api.js";
import { appOpenHref } from "./route.js";

const STATE_KEY = {
  available: "appShares.state.available",
  unavailable: "appShares.state.unavailable",
  revoked: "appShares.state.revoked",
} as const;

export function AppSharesSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  const [list, setList] = useState<AppShareList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const manage = workspaceRoleAtLeast(entry.myRole, "admin");
  // Guests cannot list or open apps; the section says nothing to them.
  const member = workspaceRoleAtLeast(entry.myRole, "member");
  const load = useCallback(() => {
    if (!member) return;
    setError(undefined);
    // Through a promise, so a client without this domain (a partial test double) is an error line,
    // not a broken detail page.
    Promise.resolve()
      .then(() => api.listAppShares(entry.id))
      .then(setList, (err: unknown) => setError(errorMessage(err)));
  }, [api, entry.id, member]);
  useEffect(() => load(), [load]);
  if (!member) return null;
  const stop = async (share: AppShare) => {
    if (!window.confirm(t("appShares.stopConfirm", { label: share.label }))) return;
    setBusy(share.id);
    try {
      const revoked = await api.revokeAppShare(entry.id, share.id);
      setList(
        (current) =>
          current && {
            ...current,
            shares: current.shares.map((s) => (s.id === revoked.id ? revoked : s)),
          },
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };
  const shares = list?.shares ?? [];
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-apps-title">
      <h3 id="workspace-apps-title">{t("appShares.title")}</h3>
      <p className="muted">{t("appShares.intro")}</p>
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
                    href={appOpenHref(entry.id, share.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("appShares.openApp")}
                  </ButtonLink>
                  {manage ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy === share.id}
                      onClick={() => void stop(share)}
                    >
                      {t("appShares.stop")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {list?.enabled ? (
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={load}>
            {t("appShares.refresh")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
