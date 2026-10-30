import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

export interface ChatViewportProps {
  conversationKey: string;
  children: ReactNode;
  label?: string;
  jumpLabel?: string;
  composer: ReactNode;
  scrollTargetId?: string | undefined;
}

/** Follows content only while at the latest message; preserves the reader's position otherwise. */
export function ChatViewport({
  conversationKey,
  children,
  composer,
  scrollTargetId,
  label = "Conversation messages",
  jumpLabel = "Back to latest",
}: ChatViewportProps) {
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchored = useRef<string | undefined>(undefined);
  const dimensions = useRef({ height: 0, content: 0 });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  const [away, setAway] = useState(false);
  const latest = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
    dimensions.current = { height: element.clientHeight, content: element.scrollHeight };
    setAway(false);
  }, []);
  useLayoutEffect(() => {
    // Changing conversations starts at its latest message, independently of the previous thread.
    if (!conversationKey) return;
    anchored.current = undefined;
    latest();
  }, [conversationKey, latest]);
  useLayoutEffect(() => {
    const target = scrollTargetId ? document.getElementById(scrollTargetId) : null;
    if (target && viewport.current?.contains(target) && anchored.current !== scrollTargetId) {
      following.current = false;
      anchored.current = scrollTargetId;
      target.scrollIntoView?.({ block: "center" });
    }
    if (following.current) latest();
  });
  useLayoutEffect(() => {
    const element = viewport.current;
    const body = content.current;
    if (!element || !body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
      dimensions.current = { height: element.clientHeight, content: element.scrollHeight };
      const isAway = element.scrollHeight - element.clientHeight - element.scrollTop > 24;
      if (!isAway) following.current = true;
      setAway(isAway);
    });
    observer.observe(element);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div className="gb-chat-scroll-frame">
        <section
          ref={viewport}
          className="gb-chat-viewport"
          aria-label={label}
          data-scrolling={scrolling ? "true" : undefined}
          onClickCapture={(event) => {
            // A disclosure is an explicit reading action. Release follow mode before its
            // resize, including keyboard activation, so expansion cannot snap to the tail.
            if (event.target instanceof Element && event.target.closest("[data-chat-disclosure]"))
              following.current = false;
          }}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable transcript must accept keyboard scrolling.
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            setScrolling(true);
            clearTimeout(idleTimer.current);
            idleTimer.current = setTimeout(() => setScrolling(false), 900);
            // Layout-induced scroll events can precede ResizeObserver delivery. Let the
            // observer preserve the previous follow mode before treating a scroll as reading.
            if (
              element.clientHeight !== dimensions.current.height ||
              element.scrollHeight !== dimensions.current.content
            )
              return;
            const isAway = element.scrollHeight - element.clientHeight - element.scrollTop > 24;
            following.current = !isAway;
            setAway(isAway);
          }}
        >
          <div ref={content} className="gb-chat-content">
            {children}
          </div>
        </section>
        {away ? (
          <div className="gb-chat-latest">
            <Button size="sm" onClick={latest}>
              <Icon name="chevron" size={16} />
              {jumpLabel}
            </Button>
          </div>
        ) : null}
      </div>
      {composer}
    </>
  );
}
