// A literal excerpt, never a generated summary. The complete message remains in the ledger;
// expanding mounts its normal safe Markdown/file renderer. Hidden links are not keyboard stops.
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { useT } from "../../i18n/i18n-provider.js";

/**
 * The share an excerpt must hide to be offered at all (owner, 2026-10-22): folding that saves at
 * most a fifth of the reading costs a click for nothing.
 */
export const FOLD_MIN_HIDDEN = 0.2;

const hiddenShare = (shown: number, total: number) => (total > 0 ? (total - shown) / total : 0);

/**
 * Whether the excerpt hides enough to fold. The rendered heights decide when the browser laid
 * both out; a link target, table or code fence counts many characters but little height. Without
 * layout (zero heights) the text decides: characters or lines hidden.
 */
export function worthFolding(
  text: { excerpt: string; body: string },
  heights?: { excerpt: number; full: number },
): boolean {
  if (heights && heights.excerpt > 0 && heights.full > 0)
    return hiddenShare(heights.excerpt, heights.full) > FOLD_MIN_HIDDEN;
  return (
    hiddenShare(Array.from(text.excerpt).length, Array.from(text.body).length) > FOLD_MIN_HIDDEN ||
    hiddenShare(text.excerpt.split("\n").length, text.body.split("\n").length) > FOLD_MIN_HIDDEN
  );
}

type Fit =
  | { body: string; phase: "full" | "excerpt"; full?: number }
  | { body: string; fold: boolean };

export function MessageContent({
  body,
  author,
  collapsible,
  prominent = false,
  reveal = false,
  renderBody,
}: {
  body: string;
  author: string;
  collapsible: boolean;
  prominent?: boolean;
  reveal?: boolean;
  renderBody: (text: string) => ReactNode;
}) {
  const t = useT();
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const characters = Array.from(body);
  const lines = body.split("\n");
  // Keep the initial reading choice when another message arrives: a newly historical answer
  // must not collapse under someone who is reading it. Reloading applies the defaults afresh.
  const [readingLatest] = useState(prominent);
  const [expanded, setExpanded] = useState(
    reveal || (prominent && characters.length <= 900 && lines.length <= 20),
  );
  useEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const long = collapsible && (characters.length > 360 || lines.length > 8);
  const excerpt = characters
    .slice(0, readingLatest ? 640 : 240)
    .join("")
    .split("\n")
    .slice(0, readingLatest ? 12 : 6)
    .join("\n")
    .trimEnd();
  const textWorth = long && worthFolding({ excerpt, body });
  // Measure once per body, before paint: the full reply, then the excerpt, then decide.
  const [fit, setFit] = useState<Fit>({ body, phase: "full" });
  const current: Fit = fit.body === body ? fit : { body, phase: "full" };
  useLayoutEffect(() => {
    if (!textWorth || "fold" in current) return;
    const height = content.current?.offsetHeight ?? 0;
    if (current.phase === "full") {
      setFit(height > 0 ? { body, phase: "excerpt", full: height } : { body, fold: true });
      return;
    }
    setFit({
      body,
      fold: worthFolding({ excerpt, body }, { excerpt: height, full: current.full ?? 0 }),
    });
  });
  if (!textWorth) return <>{renderBody(body)}</>;
  if (!("fold" in current))
    return (
      <div className="message-content">
        <div ref={content}>{renderBody(current.phase === "full" ? body : `${excerpt}\n…`)}</div>
      </div>
    );
  if (!current.fold) return <>{renderBody(body)}</>;
  return (
    <div className="message-content">
      <div id={id}>{renderBody(expanded ? body : `${excerpt}\n…`)}</div>
      <div className="message-disclosure">
        <span className="muted small">
          {t(expanded ? "chatPane.message.fullLength" : "chatPane.message.excerpt", {
            count: characters.length,
          })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-chat-disclosure
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={t(expanded ? "chatPane.message.collapseFor" : "chatPane.message.expandFor", {
            name: author,
          })}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? "chatPane.message.collapse" : "chatPane.message.expand")}
        </Button>
      </div>
    </div>
  );
}
