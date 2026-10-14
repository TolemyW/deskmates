import { Select as HeroSelect, Label, ListBox } from "@heroui/react";
import { definedProps } from "./defined-props.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps {
  label?: string;
  "aria-label"?: string;
  id?: string;
  name?: string;
  value: string;
  options: readonly (SelectOption | null | false | undefined)[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}

/** Controlled single selection; an empty string is a real option (e.g. “All”). */
export function Select({
  label,
  options,
  value,
  onValueChange,
  disabled,
  required,
  className,
  ...props
}: SelectProps) {
  const items = options.filter((item): item is SelectOption => !!item);
  return (
    <HeroSelect
      {...definedProps(props)}
      {...definedProps({ isDisabled: disabled, isRequired: required })}
      data-gb-ui="select"
      className={`gb-select ${className ?? ""}`}
      value={value}
      onChange={(key) => {
        if (key !== null) onValueChange(String(key));
      }}
    >
      {label ? <Label>{label}</Label> : null}
      <HeroSelect.Trigger>
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover data-gb-ui="select-popover" className="gb-select-popover">
        <ListBox {...definedProps({ "aria-label": label ?? props["aria-label"] })}>
          {items.map((item) => (
            <ListBox.Item
              key={item.value}
              id={item.value}
              textValue={item.label}
              isDisabled={item.disabled ?? false}
            >
              <Label>{item.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
