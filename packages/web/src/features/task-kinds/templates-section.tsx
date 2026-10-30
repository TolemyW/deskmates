import type { TaskTemplate, WorkspaceId } from "@deskmates/contracts";
import { Pill } from "@deskmates/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import {
  EMPTY_DRAFT,
  type TemplateDraft,
  TemplateEditor,
  draftOfTemplate,
} from "./template-editor.js";
import { reviewLabel, slaLabel } from "./template-text.js";

/** The body of the Templates dialog, whose title names it; it has no heading of its own. */
export function TemplatesSection({
  api,
  workspaceId,
  onChanged,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  /** Told after a save or an archive. */
  onChanged?: (() => void) | undefined;
}) {
  const t = useT();
  const canManage = useCan("taskTemplate.manage", workspaceId).allowed;
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState(false);
  const archivePending = useRef(false);
  const mounted = useRef(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editor, setEditor] = useState<{ initial: TemplateDraft; editing?: TaskTemplate }>();
  const sectionRef = useRef<HTMLElement>(null);
  const returnKey = useRef<string | null>(null);
  useEffect(() => {
    if (editor || !returnKey.current) return;
    const buttons =
      sectionRef.current?.querySelectorAll<HTMLButtonElement>("button[data-editor-key]");
    const button = Array.from(buttons ?? []).find(
      (item) => item.dataset.editorKey === returnKey.current,
    );
    button?.focus();
    returnKey.current = null;
  }, [editor]);
  // Each list request takes a number; only the newest answer, while the dialog is open, shows.
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!canManage) setEditor(undefined);
  }, [canManage]);
  const load = useCallback(() => {
    const request = ++sequence.current;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    api.listTaskTemplates(workspaceId).then(
      (list) => {
        if (request !== sequence.current) return;
        setLoading(false);
        setTemplates(list);
        setError("");
      },
      (err: unknown) => {
        if (request !== sequence.current) return;
        setLoading(false);
        setLoadFailed(true);
        setError(errorMessage(err));
      },
    );
  }, [api, workspaceId]);
  useEffect(() => load(), [load]);
  const archive = async (template: TaskTemplate) => {
    if (!canManage || archivePending.current) return;
    archivePending.current = true;
    setArchiving(true);
    setError("");
    try {
      await api.archiveTaskTemplate(workspaceId, template.id, template.version);
      if (!mounted.current) return;
      load();
      onChanged?.();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      archivePending.current = false;
      if (mounted.current) setArchiving(false);
    }
  };
  return (
    <section
      ref={sectionRef}
      onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>("button[data-editor-key]");
        if (button) returnKey.current = button.dataset.editorKey ?? null;
      }}
      className="task-templates"
      aria-label={t("taskKinds.templates.region")}
    >
      {canManage && !editor ? (
        <div className="task-kind-stats-heading">
          <Button
            disabled={archiving}
            data-editor-key="new"
            type="button"
            onClick={() => setEditor({ initial: EMPTY_DRAFT })}
          >
            {t("taskKinds.templates.new")}
          </Button>
        </div>
      ) : null}
      {!editor ? <p className="muted small">{t("taskKinds.templates.intro")}</p> : null}
      <RoleNote action="taskTemplate.manage" does={t("taskKinds.templates.roleNote")} />
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {loadFailed ? (
        <Button type="button" onClick={load} disabled={loading}>
          {t("taskKinds.templates.retry")}
        </Button>
      ) : null}
      {loading ? <output>{t("taskKinds.templates.loading")}</output> : null}
      {!loading && !error && !editor && templates.length === 0 ? (
        <p className="muted">{t("taskKinds.templates.empty")}</p>
      ) : null}
      {editor && canManage ? (
        <TemplateEditor
          api={api}
          workspaceId={workspaceId}
          editing={editor.editing}
          initial={editor.initial}
          onSaved={() => {
            setEditor(undefined);
            load();
            onChanged?.();
          }}
          onCancel={() => setEditor(undefined)}
        />
      ) : null}
      {!editor ? (
        <ul className="task-template-list">
          {templates.map((template) => (
            <li key={template.id}>
              <div>
                <strong>{template.name}</strong> <code className="small">{template.kind}</code>{" "}
                {template.builtIn ? (
                  <Pill tone="info">{t("taskKinds.templates.builtIn")}</Pill>
                ) : null}
              </div>
              <p className="muted small">{template.description}</p>
              <p className="muted small">
                {template.stages.map((s) => s.name).join(" → ")} ·{" "}
                {slaLabel(t, template.slaMinutes)} · {reviewLabel(t, template.review)}
              </p>
              {canManage ? (
                <div className="task-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={archiving}
                    data-editor-key={`copy-${template.id}`}
                    onClick={() => setEditor({ initial: draftOfTemplate(template, true) })}
                  >
                    {t("taskKinds.templates.copy")}
                  </Button>
                  {!template.builtIn ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={archiving}
                        data-editor-key={`edit-${template.id}`}
                        onClick={() =>
                          setEditor({ initial: draftOfTemplate(template), editing: template })
                        }
                      >
                        {t("taskKinds.templates.edit")}
                      </Button>
                      <Button
                        disabled={archiving}
                        type="button"
                        variant="ghost"
                        onClick={() => void archive(template)}
                      >
                        {t("taskKinds.templates.archive")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
