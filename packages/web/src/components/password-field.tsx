// A password input with a Show/Hide toggle: the shell's invitation page and Account settings
// both use it. The value lives only in the caller's state; the toggle only changes the input type.

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/i18n-provider.js";
import { Input } from "./ui/input.js";

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="account-password-field">
      <label htmlFor={id}>{label}</label>
      <div className="account-password-input">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={
            visible
              ? t("passwordField.hide", { field: label })
              : t("passwordField.show", { field: label })
          }
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
