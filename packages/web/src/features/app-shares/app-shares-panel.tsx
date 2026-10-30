// A workspace's published apps (ADR-0035, owner-decided 2026-10-14): each app's state and
// address, Open (a new tab through the entry page), Stop sharing, and a form to share a running
// port. Every Member may publish and stop; Guests never reach it. Used by the Files page and the
// workspace detail page; the Gateway decides, and a refusal shows its message.

import { type AppShare, appSharePortAllowed } from "@deskmates/contracts";
import { Input } from "@deskmates/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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

interface AppSharesPanelProps {
  api: AppSharesApi;
  workspaceId: string;
  /** Told every list the panel shows, for a count beside an entry button. */
  onList?: (list: AppShareList) => void;
}

export function AppSharesPanel(props: AppSharesPanelProps) {
  return <WorkspaceAppSharesPanel key={props.workspaceId} {...props} />;
}

function WorkspaceAppSharesPanel({ api, workspaceId, onList }: AppSharesPanelProps) {
  const t = useT();
  const [list, setList] = useState<AppShareList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");
  // Each list request and each Publish or Stop answer takes a number; a list that arrives after a
  // newer answer, or after the panel is gone, is dropped instead of overwriting it.
  const sequence = useRef(0);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const currentList = useRef<AppShareList | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  const show = useCallback(
    (next: AppShareList) => {
      currentList.current = next;
      setList(next);
      onList?.(next);
    },
    [onList],
  );
  const load = useCallback(() => {
    const request = ++sequence.current;
    setError(undefined);
    // Through a promise, so a client without this domain (a partial test double) is an error line,
    // not a broken page.
    Promise.resolve()
      .then(() => api.listAppShares(workspaceId))
      .then(
        (next) => {
          if (request === sequence.current) show(next);
        },
        (err: unknown) => {
          if (request === sequence.current) setError(errorMessage(err));
        },
      );
  }, [api, workspaceId, show]);
  useEffect(() => load(), [load]);

  const stop = async (share: AppShare) => {
    if (mutating.current) return;
    if (!window.confirm(t("appShares.stopConfirm", { label: share.label }))) return;
    mutating.current = true;
    setBusy(share.id);
    setError(undefined);
    try {
      const revoked = await api.revokeAppShare(workspaceId, share.id);
      if (!mounted.current) return;
      sequence.current += 1;
      const latest = currentList.current;
      if (latest)
        show({ ...latest, shares: latest.shares.map((s) => (s.id === revoked.id ? revoked : s)) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      mutating.current = false;
      setBusy(undefined);
    }
  };

  const publish = async () => {
    if (mutating.current) return;
    mutating.current = true;
    setBusy("publish");
    setError(undefined);
    try {
      const { share } = await api.publishAppShare(workspaceId, Number(port), label.trim());
      if (!mounted.current) return;
      sequence.current += 1;
      const others = (currentList.current?.shares ?? []).filter((s) => s.id !== share.id);
      show({ enabled: true, shares: [share, ...others] });
      setPort("");
      setLabel("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      mutating.current = false;
      setBusy(undefined);
    }
  };

  const shares = list?.shares ?? [];
  const portValid = /^\d+$/.test(port.trim()) && appSharePortAllowed(Number(port));
  return (
    <div className="app-shares-panel">
      {error ? (
        <div className="error" role="alert">
          {error}
          {!list ? (
            <Button type="button" variant="outline" disabled={busy !== undefined} onClick={load}>
              {t("appShares.refresh")}
            </Button>
          ) : null}
        </div>
      ) : null}
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
                    disabled={busy !== undefined}
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
            aria-invalid={port !== "" && !portValid ? true : undefined}
            aria-describedby={port !== "" && !portValid ? "app-share-port-error" : undefined}
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
          {port !== "" && !portValid ? (
            <p id="app-share-port-error" className="error small">
              {t("appShares.portInvalid")}
            </p>
          ) : null}
          <div className="form-actions">
            <Button
              type="submit"
              disabled={busy !== undefined || !portValid || label.trim() === ""}
            >
              {t("appShares.publish")}
            </Button>
            <Button type="button" variant="outline" disabled={busy !== undefined} onClick={load}>
              {t("appShares.refresh")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
