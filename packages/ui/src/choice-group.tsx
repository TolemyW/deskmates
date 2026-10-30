import type { ReactNode } from "react";
import { Button } from "./button.js";

export interface ChoiceItem<K extends string> {
  key: K;
  label: string;
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
}

/** Mutually exclusive filters or display modes, not navigation or tab panels. */
export function ChoiceGroup<K extends string>({
  label,
  items,
  value,
  onChange,
  iconOnly = false,
}: {
  label: string;
  items: readonly ChoiceItem<K>[];
  value: K;
  onChange: (value: K) => void;
  iconOnly?: boolean;
}) {
  return (
    <fieldset aria-label={label} className="gb-choice-group" data-choice-group>
      {items.map((item) => (
        <Button
          key={item.key}
          aria-label={item.label}
          aria-pressed={item.key === value}
          disabled={item.disabled ?? false}
          variant={item.key === value ? "secondary" : "tertiary"}
          size={iconOnly ? "icon" : "default"}
          className="gb-choice-item"
          onClick={() => onChange(item.key)}
        >
          {item.icon ? (
            <span aria-hidden="true" className="gb-choice-icon">
              {item.icon}
            </span>
          ) : null}
          {!iconOnly ? <span data-tab-label>{item.label}</span> : null}
          {item.count !== undefined ? <span aria-hidden="true">{item.count}</span> : null}
        </Button>
      ))}
    </fieldset>
  );
}
