// "This run was wrong" (issue #11, ADR-0042 decision 3): one bit and an optional note. While a run
// is marked, the group's memory consolidation skips what it learned; unmarking restores it. The
// drawer and the Activity card share this control; the Gateway decides who may mark (Owner or
// Admin), the role gate only says so in advance.

import { RUN_MARK_NOTE_MAX, type RunId, type RunMark } from "@deskmates/contracts";
import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useActorLabel, useCan } from "../../state/session-roles.js";

/** What a caller does to mark and unmark a run; both resolve once the Gateway has stored it. */
export interface RunMarkActions {
  mark(id: RunId, note?: string): Promise<RunMark>;
  unmark(id: RunId): Promise<boolean>;
}

/** The small label a marked run carries on the index, the drawer and the Activity card. */
export function RunMarkBadge({ mark }: { mark: RunMark | undefined }) {
  const t = useT();
  if (!mark) return null;
  return (
    <span className="run-mark-badge" title={mark.note ?? undefined} data-testid="run-mark-badge">
      {t("runMark.badge")}
    </span>
  );
}

export interface RunMarkControlProps {
  runId: RunId;
  mark: RunMark | undefined;
  actions: RunMarkActions;
  /** Called with the run's mark after a change; undefined after unmarking. */
  onChange: (mark: RunMark | undefined) => void;
  /** Overrides the session's role answer, for a screen handed the role directly. */
  canMark?: boolean;
}

export function RunMarkControl({ runId, mark, actions, onChange, canMark }: RunMarkControlProps) {
  const t = useT();
  const can = useCan("run.mark");
  const allowed = canMark ?? can.allowed;
  const actorLabel = useActorLabel();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = note.trim();
      onChange(await actions.mark(runId, trimmed === "" ? undefined : trimmed));
      setEditing(false);
      setNote("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unmark = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await actions.unmark(runId);
      onChange(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="run-mark" data-testid="run-mark">
      {mark ? (
        <p className="small">
          <RunMarkBadge mark={mark} />{" "}
          {t("runMark.by", { who: actorLabel(mark.markedBy), when: formatDateTime(mark.markedAt) })}
          {mark.note ? <q className="run-mark-note">{mark.note}</q> : null}
        </p>
      ) : null}
      {mark ? <p className="muted small">{t("runMark.effect")}</p> : null}
      {editing ? (
        <div className="run-mark-form">
          <label className="small">
            {t("runMark.noteLabel")}
            <textarea
              value={note}
              maxLength={RUN_MARK_NOTE_MAX}
              rows={3}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {t("runMark.save")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setNote("");
            }}
          >
            {t("runMark.cancel")}
          </Button>
        </div>
      ) : allowed ? (
        mark ? (
          <button type="button" className="link" disabled={busy} onClick={() => void unmark()}>
            {t("runMark.unmark")}
          </button>
        ) : (
          <button type="button" className="link" disabled={busy} onClick={() => setEditing(true)}>
            {t("runMark.markWrong")}
          </button>
        )
      ) : null}
      {/* Only a standing mark explains who may change it; an unmarked run offers nothing. */}
      {mark ? <RoleNote action="run.mark" allowed={allowed} does={t("runMark.roleNote")} /> : null}
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
