import { Table as HeroTable } from "@heroui/react";
import type { ComponentProps } from "react";

export interface TableProps extends ComponentProps<"table"> {
  variant?: "primary" | "secondary";
}

/** Read-only data tables keep native semantics and use HeroUI's table slots.
 * Interactive controls inside cells retain their own keyboard navigation.
 */
export function Table({ variant = "primary", className = "", children, ...props }: TableProps) {
  return (
    <HeroTable.Root variant={variant} data-gb-ui="table">
      <HeroTable.ScrollContainer
        tabIndex={0}
        // biome-ignore lint/a11y/useSemanticElements: upstream renders a div; name its keyboard-scrollable region.
        role="region"
        aria-label={props["aria-label"] ?? "Table scroll area"}
      >
        <table {...props} className={`table__content ${className}`}>
          {children}
        </table>
      </HeroTable.ScrollContainer>
    </HeroTable.Root>
  );
}
export function TableHeader({ className = "", ...props }: ComponentProps<"thead">) {
  return <thead {...props} className={`table__header ${className}`} />;
}
export function TableBody({ className = "", ...props }: ComponentProps<"tbody">) {
  return <tbody {...props} className={`table__body ${className}`} />;
}
export function TableRow({ className = "", ...props }: ComponentProps<"tr">) {
  return <tr {...props} className={`table__row ${className}`} />;
}
export function TableHead({ className = "", scope = "col", ...props }: ComponentProps<"th">) {
  return <th {...props} scope={scope} className={`table__column ${className}`} />;
}
export function TableCell({ className = "", ...props }: ComponentProps<"td">) {
  return <td {...props} className={`table__cell ${className}`} />;
}
