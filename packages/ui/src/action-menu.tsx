import { Dropdown, Label, buttonVariants } from "@heroui/react";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";

export interface ActionMenuItem {
  id: string;
  label: string;
  onAction: () => void;
  disabled?: boolean;
  /** `danger` marks an item that removes or hides something. */
  tone?: "default" | "danger";
}

export interface ActionMenuProps {
  /** The trigger's accessible name, e.g. “More actions for <row>”. */
  label: string;
  items: readonly (ActionMenuItem | null | false | undefined)[];
  disabled?: boolean;
  /** Replaces the default ellipsis glyph. */
  icon?: ReactNode;
  className?: string;
}

/**
 * A compact secondary-action menu: an icon-only trigger and a HeroUI menu with keyboard
 * navigation (arrows, Home/End, typeahead, Escape returns focus to the trigger).
 */
export function ActionMenu({ label, items, disabled = false, icon, className }: ActionMenuProps) {
  const entries = items.filter((item): item is ActionMenuItem => !!item);
  const disabledKeys = entries.filter((item) => item.disabled).map((item) => item.id);
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={label}
        isDisabled={disabled}
        data-gb-ui="action-menu-trigger"
        className={`${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} gb-action-menu-trigger ${className ?? ""}`}
      >
        {icon ?? <Ellipsis size={16} aria-hidden="true" />}
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" data-gb-ui="action-menu-popover">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={disabledKeys}
          onAction={(key) => entries.find((item) => item.id === String(key))?.onAction()}
        >
          {entries.map((item) => (
            <Dropdown.Item
              key={item.id}
              id={item.id}
              textValue={item.label}
              variant={item.tone === "danger" ? "danger" : "default"}
            >
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
