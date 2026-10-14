import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}
export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div data-gb-ui="empty-state" className="gb-empty-state">
      {icon ? (
        <span className="gb-empty-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h3>{title}</h3>
      {children ? <div className="gb-empty-description">{children}</div> : null}
      {action}
    </div>
  );
}
