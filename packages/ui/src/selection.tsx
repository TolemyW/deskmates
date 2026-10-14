import { Checkbox as HeroCheckbox, Switch as HeroSwitch, Label } from "@heroui/react";
export interface SelectionProps {
  label: string;
  selected: boolean;
  onChange: (selected: boolean) => void;
  disabled?: boolean;
}
export function Switch({ label, selected, onChange, disabled = false }: SelectionProps) {
  return (
    <HeroSwitch isSelected={selected} onChange={onChange} isDisabled={disabled}>
      <HeroSwitch.Content>
        <HeroSwitch.Control>
          <HeroSwitch.Thumb />
        </HeroSwitch.Control>
        <Label>{label}</Label>
      </HeroSwitch.Content>
    </HeroSwitch>
  );
}
export function Checkbox({ label, selected, onChange, disabled = false }: SelectionProps) {
  return (
    <HeroCheckbox isSelected={selected} onChange={onChange} isDisabled={disabled}>
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{label}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
