import { useRef } from "react";

export interface ResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number, source?: "keyboard" | "pointer") => void;
  /** A right-hand panel grows when its left edge moves left. */
  reverse?: boolean;
}

/** Controlled vertical separator. The consumer owns persistence and available width. */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  reverse = false,
}: ResizeHandleProps) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.max(min, Math.min(max, next)));
  const direction = reverse ? -1 : 1;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamp(value)}
      className="gb-resize-handle"
      data-edge={reverse ? "left" : "right"}
      onKeyDown={(event) => {
        let next: number;
        if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "ArrowLeft") next = value - 16 * direction;
        else if (event.key === "ArrowRight") next = value + 16 * direction;
        else return;
        event.preventDefault();
        onChange(clamp(next), "keyboard");
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, value };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          onChange(
            clamp(drag.current.value + (event.clientX - drag.current.x) * direction),
            "pointer",
          );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}
