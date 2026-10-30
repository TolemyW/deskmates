import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** One product-page heading: title and one-line context, with at most one primary action. */
export function PageHeader({ title, description, action, children, className }: PageHeaderProps) {
  return (
    <header
      data-gb-ui="page-header"
      className={["gb-page-header", className].filter(Boolean).join(" ")}
    >
      <div className="gb-page-header-text">
        <h1>{title}</h1>
        {description ? <p className="gb-page-header-description">{description}</p> : null}
        {children}
      </div>
      {action ? <div className="gb-page-header-action">{action}</div> : null}
    </header>
  );
}
