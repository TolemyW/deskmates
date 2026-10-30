// Template management for Owners and Admins (ADR-0021 amendment 4, A4a): create a template, copy
// a built-in into a new kind, edit a workspace's own (versioned) or archive it. Stages and fields
// are written as lines, which keeps the editor small:
//
//   triage | Triage | checkpoint
//   - The customer and priority are recorded
//
//   customer | Customer | required, relates | default value

import type {
  TaskReviewRole,
  TaskTemplate,
  TaskTemplateInput,
  WorkspaceId,
} from "@deskmates/contracts";
import { Input, Select, TextArea } from "@deskmates/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { REVIEW_LABELS } from "./template-text.js";

export interface TemplateDraft {
  kind: string;
  name: string;
  description: string;
  review: TaskReviewRole;
  slaHours: string;
  stages: string;
  fields: string;
}

export const EMPTY_DRAFT: TemplateDraft = {
  kind: "",
  name: "",
  description: "",
  review: "none",
  slaHours: "",
  stages: "",
  fields: "",
};

/** A template as editable lines; a copy gets a new kind key. */
export function draftOfTemplate(template: TaskTemplate, copy = false): TemplateDraft {
  return {
    kind: copy ? `${template.kind}-custom`.slice(0, 48) : template.kind,
    name: template.name,
    description: template.description,
    review: template.review,
    slaHours: template.slaMinutes === null ? "" : String(template.slaMinutes / 60),
    stages: template.stages
      .map((s) =>
        [
          `${s.key} | ${s.name}${s.checkpointRequired ? " | checkpoint" : ""}`,
          ...s.criteria.map((c) => `- ${c.text}`),
        ].join("\n"),
      )
      .join("\n\n"),
    fields: template.fields
      .map((f) => {
        const flags = [f.required ? "required" : "", f.relates ? "relates" : ""]
          .filter(Boolean)
          .join(", ");
        return [f.key, f.label, flags, f.defaultValue].join(" | ").replace(/( \| )+$/, "");
      })
      .join("\n"),
  };
}

/** The lines back into a template body; the Gateway checks everything again. */
export function inputOfDraft(
  draft: TemplateDraft,
): TaskTemplateInput | { invalid: "stages" | "sla" } {
  const stages: TaskTemplateInput["stages"] = [];
  for (const raw of draft.stages.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      const stage = stages.at(-1);
      if (!stage) return { invalid: "stages" };
      stage.criteria.push(line.replace(/^-\s*/, ""));
      continue;
    }
    const [key = "", name = "", flag = ""] = line.split("|").map((part) => part.trim());
    stages.push({
      key,
      name: name || key,
      criteria: [],
      checkpointRequired: flag.toLowerCase() === "checkpoint",
    });
  }
  if (stages.length === 0 || stages.some((s) => s.criteria.length === 0))
    return { invalid: "stages" };
  const fields = draft.fields
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key = "", label = "", flags = "", defaultValue = ""] = line
        .split("|")
        .map((part) => part.trim());
      const set = new Set(flags.split(",").map((f) => f.trim().toLowerCase()));
      return {
        key,
        label: label || key,
        required: set.has("required"),
        relates: set.has("relates"),
        defaultValue,
      };
    });
  const hours = draft.slaHours.trim();
  const sla = hours === "" ? null : Math.round(Number(hours) * 60);
  if (sla !== null && (!Number.isFinite(sla) || sla < 1)) return { invalid: "sla" };
  return {
    kind: draft.kind.trim(),
    name: draft.name.trim(),
    description: draft.description,
    review: draft.review,
    slaMinutes: sla,
    stages,
    fields,
  };
}

export function TemplateEditor({
  api,
  workspaceId,
  editing,
  initial,
  onSaved,
  onCancel,
}: {
  api: Pick<ApiClient, "createTaskTemplate" | "updateTaskTemplate">;
  workspaceId: WorkspaceId;
  /** The workspace template being edited; absent for a new one or a copy. */
  editing?: TaskTemplate | undefined;
  initial: TemplateDraft;
  onSaved: (template: TaskTemplate) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, []);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const input = inputOfDraft(draft);
    if ("invalid" in input) {
      setError(
        input.invalid === "stages"
          ? t("taskKinds.editor.invalidStages")
          : t("taskKinds.editor.invalidSla"),
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = editing
        ? await api.updateTaskTemplate(workspaceId, editing.id, {
            ...input,
            version: editing.version,
          })
        : await api.createTaskTemplate(workspaceId, input);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      ref={formRef}
      className="task-template-editor"
      aria-label={editing ? t("taskKinds.editor.editRegion") : t("taskKinds.editor.createRegion")}
      onSubmit={(event) => void submit(event)}
    >
      <fieldset disabled={busy}>
        <div className="task-form-row">
          <label htmlFor={`${id}-kind`}>
            {t("taskKinds.editor.kind")}
            <Input
              id={`${id}-kind`}
              value={draft.kind}
              maxLength={48}
              required
              disabled={editing !== undefined}
              onChange={(event) => change("kind", event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-name`}>
            {t("taskKinds.editor.name")}
            <Input
              id={`${id}-name`}
              value={draft.name}
              maxLength={120}
              required
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
        </div>
        <p className="muted small">{t("taskKinds.editor.kindHelp")}</p>
        <label htmlFor={`${id}-description`}>
          {t("taskKinds.editor.description")}
          <TextArea
            id={`${id}-description`}
            value={draft.description}
            maxLength={4000}
            rows={2}
            onChange={(event) => change("description", event.target.value)}
          />
        </label>
        <div className="task-form-row">
          <Select
            label={t("taskKinds.editor.review")}
            value={draft.review}
            onValueChange={(value) => change("review", value as TaskReviewRole)}
            options={(Object.keys(REVIEW_LABELS) as TaskReviewRole[]).map((value) => ({
              value,
              label: t(REVIEW_LABELS[value]),
            }))}
          />
          <label htmlFor={`${id}-sla`}>
            {t("taskKinds.editor.slaHours")}
            <Input
              id={`${id}-sla`}
              value={draft.slaHours}
              inputMode="decimal"
              onChange={(event) => change("slaHours", event.target.value)}
            />
          </label>
        </div>
        <label htmlFor={`${id}-stages`}>
          {t("taskKinds.editor.stages")}
          <TextArea
            id={`${id}-stages`}
            value={draft.stages}
            rows={10}
            required
            onChange={(event) => change("stages", event.target.value)}
          />
        </label>
        <p className="muted small">{t("taskKinds.editor.stagesHelp")}</p>
        <label htmlFor={`${id}-fields`}>
          {t("taskKinds.editor.fields")}
          <TextArea
            id={`${id}-fields`}
            value={draft.fields}
            rows={4}
            onChange={(event) => change("fields", event.target.value)}
          />
        </label>
        <p className="muted small">{t("taskKinds.editor.fieldsHelp")}</p>
      </fieldset>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="task-actions">
        <Button type="submit" variant="default" disabled={busy}>
          {editing ? t("taskKinds.editor.save") : t("taskKinds.editor.create")}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("taskKinds.editor.cancel")}
        </Button>
      </div>
    </form>
  );
}
