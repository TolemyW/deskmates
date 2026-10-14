import { Card as HeroCard } from "@heroui/react";
import type { ComponentProps } from "react";

export type CardProps = ComponentProps<"div">;
export function Card({ className, children, ...props }: CardProps) {
  return (
    <HeroCard {...props} data-gb-ui="card" className={`gb-card ${className ?? ""}`}>
      {children}
    </HeroCard>
  );
}
