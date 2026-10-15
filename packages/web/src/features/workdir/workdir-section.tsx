// Detail › Working directories (ADR-0036): where this workspace's bots start, the git repository
// the platform prepares one worktree of per bot, and whether a run is told about its bot's other
// live lane. A convention and tooling, never a permission; each setting changes the bots' prompts,
// so it is an experiment, not a default. Opening the section only reads.

import type {
  BotWorkdirMode,
  WorkdirSettingsInput,
  WorkdirSettingsView,
} from "@deskmates/contracts";
import { worktreeRepoProblem } from "@deskmates/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import type { DetailSectionProps } from "../workspaces/detail-sections.js";

type ModeChoice = "inherit" | BotWorkdirMode;

interface Draft {
  mode: ModeChoice;
  repo: string;
  laneNotice: boolean;
}

function draftOf(view: WorkdirSettingsView): Draft {
  return {
    mode: view.settings.mode ?? "inherit",
    repo: view.settings.worktreeRepo ?? "",
    laneNotice: view.settings.laneNotice === true,
  };
}

function inputOf(draft: Draft): WorkdirSettingsInput {
  const perBot = draft.mode === "per-bot";
  return {
    mode: draft.mode === "inherit" ? null : draft.mode,
    worktreeRepo: perBot && draft.repo.trim() !== "" ? draft.repo.trim() : null,
    laneNotice: draft.laneNotice ? true : null,
  };
}

export function WorkdirSection({ api, entry }: DetailSectionProps) {
  const t = useT();
  const workspaceId = entry.id;
  const canSet = useCan("workdir.set", workspaceId).allowed && !entry.archivedAt;
  const [view, setView] = useState<WorkdirSettingsView>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setView(undefined);
    setDraft(undefined);
    api
      .getWorkspaceWorkdir(workspaceId)
      .then((next) => active && setView(next))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, workspaceId]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const input = inputOf(draft);
    if (typeof input.worktreeRepo === "string" && worktreeRepoProblem(input.worktreeRepo)) {
      setError(t("workdir.invalidRepo"));
      return;
    }
    setBusy(true);
    setError("");
    api
      .setWorkspaceWorkdir(workspaceId, input)
      .then((next) => {
        setView(next);
        setDraft(undefined);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const modeText = (mode: BotWorkdirMode) => t(`workdir.mode.${mode}`);

  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-workdir-title">
      <h3 id="workspace-workdir-title">{t("workdir.title")}</h3>
      <p className="muted small">{t("workdir.intro")}</p>
      {!view ? (
        error ? null : (
          <p className="muted small">{t("workdir.loading")}</p>
        )
      ) : draft ? (
        <form className="workdir-form" onSubmit={save}>
          <label>
            {t("workdir.modeLabel")}
            <select
              value={draft.mode}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as ModeChoice })}
            >
              <option value="inherit">
                {t("workdir.inherit", { mode: modeText(view.gatewayMode) })}
              </option>
              <option value="shared">{modeText("shared")}</option>
              <option value="per-bot">{modeText("per-bot")}</option>
            </select>
          </label>
          <label>
            {t("workdir.repoLabel")}
            <input
              value={draft.repo}
              disabled={draft.mode !== "per-bot"}
              placeholder={t("workdir.repoPlaceholder")}
              onChange={(event) => setDraft({ ...draft, repo: event.target.value })}
            />
          </label>
          <p className="muted small">{t("workdir.repoHelp")}</p>
          <label className="workdir-check">
            <input
              type="checkbox"
              checked={draft.laneNotice}
              onChange={(event) => setDraft({ ...draft, laneNotice: event.target.checked })}
            />
            {t("workdir.laneNoticeLabel")}
          </label>
          <p className="muted small">{t("workdir.experiment")}</p>
          <div className="form-actions">
            <Button type="submit" disabled={busy}>
              {t("workdir.save")}
            </Button>
            <Button type="button" variant="tertiary" onClick={() => setDraft(undefined)}>
              {t("workdir.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="workdir-list">
            <div>
              <dt>{t("workdir.modeLabel")}</dt>
              <dd>
                {t("workdir.effective", {
                  value: modeText(view.effective.mode),
                  source: t(`workdir.source.${view.effective.source}`),
                })}
              </dd>
            </div>
            <div>
              <dt>{t("workdir.repoLabel")}</dt>
              <dd>{view.effective.worktreeRepo ?? t("workdir.none")}</dd>
            </div>
            <div>
              <dt>{t("workdir.laneNoticeLabel")}</dt>
              <dd>{view.effective.laneNotice ? t("workdir.on") : t("workdir.off")}</dd>
            </div>
          </dl>
          <p className="muted small">{t("workdir.convention")}</p>
          {canSet ? (
            <Button type="button" variant="tertiary" onClick={() => setDraft(draftOf(view))}>
              {t("workdir.edit")}
            </Button>
          ) : entry.archivedAt ? null : (
            <RoleNote action="workdir.set" does={t("workdir.roleNote")} />
          )}
        </>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
