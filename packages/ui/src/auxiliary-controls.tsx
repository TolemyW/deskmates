import { Button, Popover, Tooltip } from "@heroui/react";
import { CircleHelp } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Short, nonessential guidance; hover/focus reveals it, touch can explicitly open it. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip isOpen={open} onOpenChange={setOpen} delay={250}>
      <Button
        data-help-tip
        aria-label={label}
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={() => setOpen(true)}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </Button>
      <Tooltip.Content className="gb-help-tip">{children}</Tooltip.Content>
    </Tooltip>
  );
}

export function ControlPopover({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover>
      <Button data-control-popover-trigger variant="tertiary" aria-label={label}>
        {trigger}
      </Button>
      <Popover.Content placement="bottom end">
        <Popover.Dialog aria-label={label} className="gb-control-popover">
          {children}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
