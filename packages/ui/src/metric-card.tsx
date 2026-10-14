import type { ReactNode } from "react";
import { Card } from "./card.js";

export function MetricCard({
  label,
  value,
  detail,
  className = "",
}: { label: string; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <Card className={`gb-metric-card ${className}`}>
      <span>{label}</span>
      <div>
        <strong>{value}</strong>
        {detail}
      </div>
    </Card>
  );
}
