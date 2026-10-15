// A bot model choice (ADR-0039 decision 8): the deployment default, any model the Gateway's
// registry names (labelled with the upstream that serves it), or another id typed by hand for a
// model the default upstream serves without listing it. The value is the override: "" follows
// the deployment default.

import type { RegisteredModel } from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";

const DEFAULT = "default";
const CUSTOM = "custom";
const MODEL_PREFIX = "model:";

type Choice = string;

export function registeredModelLabel(
  t: ReturnType<typeof useT>,
  models: readonly RegisteredModel[],
  model: string,
): string {
  const upstream = models.find((entry) => entry.model === model)?.upstream;
  return upstream === undefined ? model : t("management.model.registered", { model, upstream });
}

export function ModelPicker({
  label,
  overrideLabel,
  value,
  onChange,
  deploymentModel,
  models,
  disabled,
}: {
  label: string;
  overrideLabel: string;
  /** The override; "" follows the deployment default. */
  value: string;
  onChange: (value: string) => void;
  /** The deployment's model for this slot (`DEFAULT_MODEL` or `CHEAP_MODEL`). */
  deploymentModel: string;
  models: readonly RegisteredModel[];
  disabled?: boolean;
}) {
  const t = useT();
  // The deployment model is the default choice, not a second entry for the same id.
  const choices = models.filter((entry) => entry.model !== deploymentModel);
  const choiceOf = (override: string): Choice =>
    override === "" || override === deploymentModel
      ? DEFAULT
      : choices.some((entry) => entry.model === override)
        ? `${MODEL_PREFIX}${override}`
        : CUSTOM;
  const [choice, setChoice] = useState<Choice>(() => choiceOf(value));
  const [custom, setCustom] = useState(() => (choiceOf(value) === CUSTOM ? value : ""));
  const pick = (next: Choice) => {
    setChoice(next);
    if (next === DEFAULT) onChange("");
    else if (next === CUSTOM) onChange(custom);
    else onChange(next.slice(MODEL_PREFIX.length));
  };
  return (
    <>
      <Select
        label={label}
        value={choice}
        onValueChange={pick}
        disabled={disabled ?? false}
        options={[
          {
            value: DEFAULT,
            label: t("management.model.deploymentDefault", {
              model: registeredModelLabel(t, models, deploymentModel),
            }),
          },
          ...choices.map((entry) => ({
            value: `${MODEL_PREFIX}${entry.model}`,
            label: t("management.model.registered", {
              model: entry.model,
              upstream: entry.upstream,
            }),
          })),
          { value: CUSTOM, label: t("management.model.another") },
        ]}
      />
      {choice === CUSTOM ? (
        <label>
          {overrideLabel}
          <input
            value={custom}
            placeholder={t("management.model.overridePlaceholder")}
            onChange={(event) => {
              setCustom(event.target.value);
              onChange(event.target.value);
            }}
          />
        </label>
      ) : null}
    </>
  );
}

/** Suggestions for a free-text model field: every registered model with its upstream. */
export function ModelSuggestions({
  id,
  models,
}: {
  id: string;
  models: readonly RegisteredModel[];
}) {
  const t = useT();
  return (
    <datalist id={id}>
      {models.map((entry) => (
        <option key={entry.model} value={entry.model}>
          {t("management.model.registered", { model: entry.model, upstream: entry.upstream })}
        </option>
      ))}
    </datalist>
  );
}
