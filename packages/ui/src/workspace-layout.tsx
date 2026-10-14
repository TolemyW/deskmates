import { type ReactNode, useId, useRef } from "react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

export interface WorkspaceLayoutProps {
  title: string;
  subtitle?: string;
  navigationLabel: string;
  sidebar: (close: () => void) => ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Shared application frame. Native modal navigation retains keyboard access on narrow screens. */
export function WorkspaceLayout({
  title,
  subtitle,
  navigationLabel,
  sidebar,
  actions,
  children,
  className = "",
}: WorkspaceLayoutProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = () => dialog.current?.close();
  return (
    <div className={`gb-workspace ${className}`}>
      <aside className="gb-workspace-sidebar" aria-label={navigationLabel}>
        {sidebar(close)}
      </aside>
      <dialog ref={dialog} id={id} className="gb-workspace-drawer" aria-label={navigationLabel}>
        <div className="gb-drawer-heading">
          <strong>{navigationLabel}</strong>
          <Button size="icon" variant="ghost" aria-label="Close navigation" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>
        {sidebar(close)}
      </dialog>
      <section className="gb-workspace-main" aria-label={title}>
        <header className="gb-workspace-header">
          <Button
            className="gb-navigation-toggle"
            variant="ghost"
            size="icon"
            aria-label={`Open ${navigationLabel.toLowerCase()}`}
            aria-haspopup="dialog"
            aria-controls={id}
            onClick={() => dialog.current?.showModal()}
          >
            <Icon name="menu" />
          </Button>
          <div className="gb-workspace-heading">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="gb-workspace-actions">{actions}</div> : null}
        </header>
        {children}
      </section>
    </div>
  );
}
