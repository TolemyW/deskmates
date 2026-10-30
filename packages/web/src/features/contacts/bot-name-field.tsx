// A bot's name is also its @mention handle and directory name. State the shared contracts rule,
// validate while the person types, and offer a valid readable suggestion instead of relying on
// the browser's native pattern bubble (issue #22 E7).

import { BOT_NAME_PATTERN, isBotName, suggestBotName } from "@deskmates/contracts";
import { useId } from "react";
import { useT } from "../../i18n/i18n-provider.js";

export function BotNameField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const invalid = value.length > 0 && !isBotName(value);
  const suggestion = invalid ? suggestBotName(value) : undefined;
  return (
    <div className="bot-name-field">
      <label htmlFor={`${id}-input`}>{label}</label>
      <input
        id={`${id}-input`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        pattern={BOT_NAME_PATTERN.source}
        placeholder={t("contacts.dialog.handlePlaceholder")}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-rule${invalid ? ` ${id}-error` : ""}`}
        disabled={disabled}
        required
      />
      <span id={`${id}-rule`} className="muted small">
        {t("contacts.botName.rule")}
      </span>
      {invalid && suggestion ? (
        <span id={`${id}-error`} className="error small" role="alert">
          {t("contacts.botName.invalid")}{" "}
          <button type="button" className="link-button" onClick={() => onChange(suggestion)}>
            {t("contacts.botName.useSuggestion", { name: suggestion })}
          </button>
        </span>
      ) : null}
    </div>
  );
}
