// The workspace name input with its weighted counter (ADR-0034 decision 1). The counter is the
// Gateway's own (`workspaceNameUnits` in contracts), so the form and the API agree. The input is
// never cut or rewritten: no `maxLength`, so IME composition and paste are untouched; an over-long
// name shows the count and disables submit, and the Gateway refuses it again.

import {
  WORKSPACE_NAME_MAX_UNITS,
  workspaceNameProblem,
  workspaceNameUnits,
} from "@deskmates/contracts";
import { useId } from "react";
import { useT } from "../../i18n/i18n-provider.js";

/** The name a form submits: surrounding whitespace dropped, nothing else changed. */
export function submittedWorkspaceName(value: string): string {
  return value.trim();
}

/** Whether a form may submit this value as a new or changed name. */
export function workspaceNameAcceptable(value: string): boolean {
  return workspaceNameProblem(submittedWorkspaceName(value)) === undefined;
}

export function WorkspaceNameField({
  value,
  onChange,
  label,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  const counterId = useId();
  const errorId = useId();
  const name = submittedWorkspaceName(value);
  const units = workspaceNameUnits(name);
  const problem = name === "" ? undefined : workspaceNameProblem(name);
  const message =
    problem?.code === "too_long"
      ? t("workspaceName.tooLong", { units, max: WORKSPACE_NAME_MAX_UNITS })
      : problem?.code === "control_character"
        ? t("workspaceName.control")
        : undefined;
  return (
    <label className="workspace-name-field">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required
        // biome-ignore lint/a11y/noAutofocus: the field opens a dialog or an explicit rename.
        autoFocus={autoFocus}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${counterId} ${errorId}` : counterId}
      />
      <span
        id={counterId}
        className={`workspace-name-counter small${problem?.code === "too_long" ? " over" : ""}`}
      >
        {t("workspaceName.counter", { units, max: WORKSPACE_NAME_MAX_UNITS })}
      </span>
      <span className="muted small">{t("workspaceName.rule")}</span>
      {message ? (
        <span id={errorId} className="error small" role="alert">
          {message}
        </span>
      ) : null}
    </label>
  );
}
