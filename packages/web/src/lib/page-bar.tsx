// The application's page bar (#113): `@deskmates/ui`'s presentational Pager with the shared
// strings and a `usePagedQuery` result. It shows nothing when the list fits on one page, and
// says "of more" instead of a number when the source has no cheap total.

import { type PageRange, Pager } from "@deskmates/ui";
import { useT } from "../i18n/i18n-provider.js";
import type { PagedQuery } from "./use-paged-query.js";

export function usePageRangeText(): (range: PageRange) => string {
  const t = useT();
  return (range) =>
    range.total === undefined
      ? range.hasMore
        ? t("pager.rangeMore", { from: range.from, to: range.to })
        : t("pager.range", { from: range.from, to: range.to, total: range.to })
      : t("pager.range", { from: range.from, to: range.to, total: range.total });
}

export function PageBar<T>({
  query,
  label,
  className,
}: {
  query: PagedQuery<T>;
  /** Accessible name of this list's page navigation; defaults to "Pages". */
  label?: string;
  className?: string;
}) {
  const t = useT();
  const rangeText = usePageRangeText();
  const { range } = query;
  // A pager with one range and two disabled buttons explains no action and wastes scarce rail
  // width. The list itself already shows those rows, so navigation exists only when it can move.
  if (!range || (!query.hasPrevious && !query.hasNext)) return null;
  return (
    <Pager
      label={label ?? t("pager.label")}
      previousLabel={t("pager.previous")}
      nextLabel={t("pager.next")}
      range={rangeText(range)}
      hasPrevious={query.hasPrevious}
      hasNext={query.hasNext}
      onPrevious={query.previous}
      onNext={query.next}
      busy={query.loading}
      rangeClassName="muted small"
      {...(className ? { className } : {})}
    />
  );
}
