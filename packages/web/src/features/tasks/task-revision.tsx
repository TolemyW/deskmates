import type { Task, WorkspaceId } from "@deskmates/contracts";
import { TextArea } from "@deskmates/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { newIdempotencyKey } from "./task-execution.js";

/**
 * Feedback and dispatch are one explicit, keyed action; a failed request keeps the draft. A lost
 * response or a server failure retries the same key with the same text, so a request that did
 * reach the Gateway is not sent twice. A conflict asks for a reload. Any other client error
 * (the Gateway rejected this text) releases the draft for editing under a fresh key: the
 * rejected request wrote nothing, and the task's version check refuses a second dispatch.
 */
export function TaskRevision({
  api,
  workspaceId,
  task,
  onChanged,
  onCancel,
  onConflict,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  task: Task;
  onChanged: (task: Task) => void;
  onCancel: () => void;
  onConflict: () => void;
}) {
  const t = useT();
  const feedbackId = useId();
  const feedbackInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    feedbackInput.current?.focus();
  }, []);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(newIdempotencyKey());
  const pending = useRef(false);
  const [submitted, setSubmitted] = useState<string | undefined>(undefined);
  return (
    <form
      className="task-revision card"
      aria-label={t("tasks.revision.heading")}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending.current || !feedback.trim()) return;
        pending.current = true;
        setBusy(true);
        setError("");
        const text = submitted ?? feedback.trim();
        setSubmitted(text);
        try {
          const result = await api.runTask(workspaceId, task.id, task.version, key.current, text);
          onChanged(result.task);
        } catch (err) {
          setError(errorMessage(err));
          if (err instanceof ApiError && err.status === 409) onConflict();
          else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            key.current = newIdempotencyKey();
            setSubmitted(undefined);
          }
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <h3>{t("tasks.revision.heading")}</h3>
      <p className="muted small">{t("tasks.revision.help")}</p>
      <label htmlFor={feedbackId}>
        {t("tasks.revision.feedback")}
        <TextArea
          ref={feedbackInput}
          id={feedbackId}
          required
          maxLength={4000}
          value={feedback}
          disabled={busy}
          readOnly={submitted !== undefined}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="task-actions">
        <Button
          type="submit"
          variant="default"
          disabled={busy || !task.ownerBotId || !feedback.trim()}
        >
          {t("tasks.revision.submit")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("tasks.revision.cancel")}
        </Button>
      </div>
    </form>
  );
}
