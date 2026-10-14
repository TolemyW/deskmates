import { Chip } from "@heroui/react";
import type { ComponentProps } from "react";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "primary";
export interface PillProps extends ComponentProps<"span"> {
  tone?: Tone;
  dot?: boolean;
}
const colors = {
  neutral: "default",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  primary: "accent",
} as const;
export function Pill({ tone = "neutral", dot = false, className, children, ...props }: PillProps) {
  return (
    <Chip
      {...props}
      color={colors[tone]}
      variant="soft"
      size="sm"
      data-gb-ui="pill"
      data-tone={tone}
      className={`gb-pill ${className ?? ""}`}
    >
      {dot ? <span className="gb-pill-dot" aria-hidden="true" /> : null}
      <Chip.Label className="gb-pill-content">{children}</Chip.Label>
    </Chip>
  );
}
