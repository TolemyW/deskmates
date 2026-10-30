// Creating a task from a template (ADR-0021 amendment 4, A4c): the Tasks create form offers a
// template, its fields and a preview of the section the Gateway appends to the description.
// Choosing no template sends exactly the request it sent before.

import type { TaskTemplate, WorkspaceId } from "@deskmates/contracts";
import { Input, Select } from "@deskmates/ui";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { reviewLabel, slaLabel } from "./template-text.js";

export interface TemplateChoice {
  templateId: string;
  fields: Record<string, string>;
}

export const NO_TEMPLATE: TemplateChoice = { templateId: "", fields: {} };

/** What the create request adds: nothing without a template. */
export function templateRequest(choice: TemplateChoice): {
  templateId?: string;
  fields?: Record<string, string>;
} {
  if (!choice.templateId) return {};
  const fields = Object.fromEntries(
    Object.entries(choice.fields).filter(([, value]) => value.trim() !== ""),
  );
  return { templateId: choice.templateId, fields };
}

export function TaskTemplateFields({
  api,
  workspaceId,
  fieldId,
  value,
  onChange,
  revision = 0,
}: {
  api: Pick<ApiClient, "listTaskTemplates">;
  workspaceId: WorkspaceId;
  fieldId: string;
  value: TemplateChoice;
  onChange: (choice: TemplateChoice) => void;
  /** Changes when templates were saved or archived elsewhere on the page; the list reloads. */
  revision?: number;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [error, setError] = useState("");
  // The latest choice, for a reload that finds the chosen template archived.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the reload trigger.
  useEffect(() => {
    let live = true;
    api.listTaskTemplates(workspaceId).then(
      (list) => {
        if (!live) return;
        setTemplates(list);
        setError("");
        const { value: chosen, onChange: change } = latest.current;
        if (chosen.templateId && !list.some((template) => template.id === chosen.templateId))
          change(NO_TEMPLATE);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, revision]);
  const chosen = templates.find((template) => template.id === value.templateId);
  const choose = (id: string) => {
    const template = templates.find((item) => item.id === id);
    onChange({
      templateId: id,
      fields: Object.fromEntries((template?.fields ?? []).map((f) => [f.key, f.defaultValue])),
    });
  };
  return (
    <div className="task-template-fields">
      <Select
        label={t("taskKinds.create.template")}
        value={value.templateId}
        onValueChange={choose}
        options={[
          { value: "", label: t("taskKinds.create.noTemplate") },
          ...templates.map((template) => ({ value: template.id, label: template.name })),
        ]}
      />
      {error ? (
        <output className="muted small">{t("taskKinds.create.unavailable", { error })}</output>
      ) : null}
      {chosen ? (
        <>
          <p className="muted small">{t("taskKinds.create.help")}</p>
          {chosen.fields.map((field) => (
            <label key={field.key} htmlFor={`${fieldId}-field-${field.key}`}>
              {field.required
                ? t("taskKinds.create.requiredField", { label: field.label })
                : field.label}
              <Input
                id={`${fieldId}-field-${field.key}`}
                value={value.fields[field.key] ?? ""}
                maxLength={200}
                required={field.required}
                onChange={(event) =>
                  onChange({
                    ...value,
                    fields: { ...value.fields, [field.key]: event.target.value },
                  })
                }
              />
            </label>
          ))}
          <details className="task-template-preview">
            <summary>{t("taskKinds.create.preview")}</summary>
            <p className="muted small">
              {slaLabel(t, chosen.slaMinutes)} · {reviewLabel(t, chosen.review)}
            </p>
            <ol>
              {chosen.stages.map((stage) => (
                <li key={stage.key}>
                  <strong>{stage.name}</strong>
                  {stage.checkpointRequired ? (
                    <span className="muted small"> {t("taskKinds.stage.checkpointRequired")}</span>
                  ) : null}
                  <ul>
                    {stage.criteria.map((criterion) => (
                      <li key={criterion.label}>
                        <code>{criterion.label}</code> {criterion.text}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : null}
    </div>
  );
}
