// Detail › Desktop tools (ADR-0048, owner rulings of 2026-10-17): whether this workspace and which
// of its bots have the native desktop tools, on by default when the image provides them (amendment
// 1, A1), whether that is the default or a choice, whether the image provides them, and, while
// they are on, the grouping exception of decision 10: such a workspace may hold a signed-in
// account and also browse untrusted sites. Opening the section only reads.

import type { DesktopToolsInput, DesktopToolsView } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";

function botChoices(view: DesktopToolsView): Record<string, boolean> {
  return Object.fromEntries(view.bots.map((b) => [b.botId, b.enabled]));
}

export function DesktopToolsSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  const workspaceId = entry.id;
  const canSet = useCan("desktopTools.set", workspaceId).allowed && !entry.archivedAt;
  const [view, setView] = useState<DesktopToolsView>();
  const [bots, setBots] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);

  const show = (next: DesktopToolsView) => {
    setView(next);
    setBots(botChoices(next));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRevision requests a local retry.
  useEffect(() => {
    let active = true;
    setView(undefined);
    setError("");
    api
      .getWorkspaceDesktopTools(workspaceId)
      .then((next) => {
        if (!active) return;
        setView(next);
        setBots(botChoices(next));
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, workspaceId, loadRevision]);

  const save = (input: DesktopToolsInput) => {
    setBusy(true);
    setError("");
    api
      .setWorkspaceDesktopTools(workspaceId, input)
      .then(show)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const changedBots = () =>
    Object.fromEntries(
      (view?.bots ?? [])
        .filter((b) => (bots[b.botId] ?? false) !== b.enabled)
        .map((b) => [b.botId, bots[b.botId] ?? false]),
    );

  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-desktop-title">
      <h3 id="workspace-desktop-title">{t("desktopTools.title")}</h3>
      <p className="muted small">{t("desktopTools.intro")}</p>
      {!view ? (
        error ? null : (
          <p className="muted small">{t("desktopTools.loading")}</p>
        )
      ) : (
        <>
          <dl className="desktop-tools-list">
            <div>
              <dt>{t("desktopTools.workspaceLabel")}</dt>
              <dd>
                {view.enabled ? t("desktopTools.on") : t("desktopTools.off")}
                {" · "}
                <span className="muted small">
                  {view.setting === "default"
                    ? t("desktopTools.setting.default")
                    : t("desktopTools.setting.chosen")}
                </span>
              </dd>
            </div>
          </dl>
          {view.enabled && (view.lcuVersion || view.appVersion) ? (
            <p className="muted small">
              {t("desktopTools.versions", {
                lcu: view.lcuVersion ?? "?",
                app: view.appVersion ?? "?",
              })}
            </p>
          ) : null}
          <p className="muted small">{t(`desktopTools.image.${view.image}`)}</p>
          {view.groupingException ? (
            <p className="desktop-tools-warning" role="note">
              {t("desktopTools.groupingWarning")}
            </p>
          ) : null}
          {view.enabled ? (
            <>
              <p className="muted small">{t("desktopTools.noApproval")}</p>
              <fieldset className="desktop-tools-bots" disabled={!canSet || busy}>
                <legend>{t("desktopTools.botsLabel")}</legend>
                {view.bots.length === 0 ? (
                  <p className="muted small">{t("desktopTools.noBots")}</p>
                ) : (
                  view.bots.map((b) => (
                    <label key={b.botId} className="desktop-tools-check">
                      <input
                        type="checkbox"
                        checked={bots[b.botId] ?? false}
                        onChange={(event) => setBots({ ...bots, [b.botId]: event.target.checked })}
                      />
                      {b.name}
                    </label>
                  ))
                )}
              </fieldset>
              <p className="muted small">{t("desktopTools.strategyNote")}</p>
            </>
          ) : null}
          <p className="muted small">{t("desktopTools.frozen")}</p>
          {canSet ? (
            <div className="form-actions">
              {view.enabled ? (
                <>
                  {view.bots.length > 0 ? (
                    <Button
                      type="button"
                      disabled={busy || Object.keys(changedBots()).length === 0}
                      onClick={() => save({ bots: changedBots() })}
                    >
                      {t("desktopTools.save")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => save({ enabled: false })}
                  >
                    {t("desktopTools.disable")}
                  </Button>
                </>
              ) : view.image === "capable" ? (
                <Button type="button" disabled={busy} onClick={() => save({ enabled: true })}>
                  {t("desktopTools.enable")}
                </Button>
              ) : null}
            </div>
          ) : entry.archivedAt ? null : (
            <RoleNote action="desktopTools.set" does={t("desktopTools.roleNote")} />
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
              {t("desktopTools.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
