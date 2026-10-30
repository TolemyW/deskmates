// Detail › Web search (ADR-0049 decision 4): whether this workspace's bots are offered the
// `web_search` tool, on by default when configured, whether that is the default or a choice, and whether the
// installation configures a search service at all. The section always says what turning it on
// means: queries leave the installation for public search engines, from a locked workspace too,
// while opening a result still follows the workspace's egress rules. Opening the section only reads.

import type { WebSearchInput, WebSearchView } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";

export function WebSearchSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  const workspaceId = entry.id;
  const canSet = useCan("webSearch.set", workspaceId).allowed && !entry.archivedAt;
  const [view, setView] = useState<WebSearchView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRevision requests an explicit retry.
  useEffect(() => {
    let active = true;
    setView(undefined);
    setError("");
    api
      .getWorkspaceWebSearch(workspaceId)
      .then((next) => active && setView(next))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, workspaceId, loadRevision]);

  const save = (input: WebSearchInput) => {
    setBusy(true);
    setError("");
    api
      .setWorkspaceWebSearch(workspaceId, input)
      .then(setView)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-web-search-title">
      <h3 id="workspace-web-search-title">{t("webSearch.title")}</h3>
      <p className="muted small">{t("webSearch.intro")}</p>
      {!view ? (
        error ? null : (
          <p className="muted small">{t("webSearch.loading")}</p>
        )
      ) : (
        <>
          <dl className="web-search-list">
            <div>
              <dt>{t("webSearch.workspaceLabel")}</dt>
              <dd>
                {view.effective ? t("webSearch.on") : t("webSearch.off")}
                {" · "}
                <span className="muted small">
                  {view.enabled === null
                    ? t("webSearch.setting.default")
                    : t("webSearch.setting.chosen")}
                </span>
              </dd>
            </div>
          </dl>
          {view.configured ? null : <p className="muted small">{t("webSearch.notConfigured")}</p>}
          <p className="web-search-note" role="note">
            {t("webSearch.flow")}
          </p>
          <p className="muted small">{t("webSearch.strategyNote")}</p>
          <p className="muted small">{t("webSearch.frozen")}</p>
          {canSet ? (
            <div className="form-actions">
              {view.enabled === true || view.effective ? (
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => save({ enabled: false })}
                >
                  {t("webSearch.disable")}
                </Button>
              ) : view.configured ? (
                <Button type="button" disabled={busy} onClick={() => save({ enabled: true })}>
                  {t("webSearch.enable")}
                </Button>
              ) : null}
              {view.enabled !== null ? (
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => save({ enabled: null })}
                >
                  {t("webSearch.reset")}
                </Button>
              ) : null}
            </div>
          ) : entry.archivedAt ? null : (
            <RoleNote action="webSearch.set" does={t("webSearch.roleNote")} />
          )}
        </>
      )}
      {error ? (
        <div className="error" role="alert">
          {error}
          {!view ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setLoadRevision((value) => value + 1)}
            >
              {t("webSearch.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
