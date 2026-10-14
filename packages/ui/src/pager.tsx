import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button.js";

/**
 * The visible slice of a list. `total` is omitted when the source cannot count cheaply; then the
 * caller says "of more" (or nothing more) from `hasMore`, never a guessed number.
 */
export interface PageRange {
  from: number;
  to: number;
  total?: number;
  hasMore: boolean;
}

export interface PagerProps {
  /** Accessible name of the navigation landmark, e.g. "Pages" or "Document pages". */
  label: string;
  previousLabel: string;
  nextLabel: string;
  /** The caller-formatted range text, e.g. "26–50 of 80" or "26–50 of more". */
  range: ReactNode;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** While a page loads both controls are disabled, so a double click cannot skip a page. */
  busy?: boolean;
  className?: string;
  rangeClassName?: string;
}

/**
 * Presentational Previous/Next page bar. It owns no paging state and no strings: the consumer
 * supplies labels, the range text and the callbacks. Disabled boundaries use native `disabled`.
 */
export function Pager({
  label,
  previousLabel,
  nextLabel,
  range,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  busy = false,
  className,
  rangeClassName = "gb-pager-range",
}: PagerProps) {
  return (
    <nav className={`gb-pager ${className ?? ""}`} aria-label={label}>
      <Button type="button" variant="ghost" disabled={busy || !hasPrevious} onClick={onPrevious}>
        <ChevronLeft size={16} aria-hidden="true" /> {previousLabel}
      </Button>
      <span className={rangeClassName} aria-live="polite">
        {range}
      </span>
      <Button type="button" variant="ghost" disabled={busy || !hasNext} onClick={onNext}>
        {nextLabel} <ChevronRight size={16} aria-hidden="true" />
      </Button>
    </nav>
  );
}
