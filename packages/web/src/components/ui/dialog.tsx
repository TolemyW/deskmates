import { ResizeHandle } from "@deskmates/ui";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { cn } from "../../lib/utils.js";
import { usePanelWidth } from "../../state/panel-width.js";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  children,
  className,
  closeLabel,
  placement = "center",
  dock,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  closeLabel?: string;
  placement?: "center" | "right";
  dock?: { host: HTMLElement; hidden: boolean; width: ReturnType<typeof usePanelWidth> };
}) {
  const t = useT();
  const modalPanel = usePanelWidth("drawer", 640, 320, (vw) => Math.min(1100, vw - 24));
  const panel = dock?.width ?? modalPanel;
  return (
    <DialogPrimitive.Portal container={dock?.host}>
      {!dock && (
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      )}
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-background p-6 shadow-2xl outline-none",
          placement === "right"
            ? "inset-y-3 right-3 w-[min(760px,calc(100vw-24px))]"
            : "left-1/2 top-1/2 max-h-[92dvh] w-[min(96vw,1100px)] -translate-x-1/2 -translate-y-1/2",
          className,
          dock && "docked-detail",
        )}
        {...props}
        onInteractOutside={(event) =>
          dock ? event.preventDefault() : props.onInteractOutside?.(event)
        }
        onEscapeKeyDown={(event) =>
          dock?.hidden ? event.preventDefault() : props.onEscapeKeyDown?.(event)
        }
        hidden={dock?.hidden}
        style={
          dock
            ? { ...props.style, width: panel.width, display: dock.hidden ? "none" : undefined }
            : placement === "right"
              ? { ...props.style, width: Math.min(panel.width, window.innerWidth - 24) }
              : props.style
        }
      >
        {placement === "right" ? (
          <ResizeHandle
            label={t("panel.resizeDrawer")}
            value={panel.width}
            min={panel.min}
            max={panel.max}
            onChange={panel.setWidth}
            reverse
          />
        ) : null}
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-md border-transparent bg-transparent p-1 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={closeLabel ?? t("dialog.closeDesktop")}
        >
          <X size={18} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
