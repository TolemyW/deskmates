// The thread composer's textarea with an @mention picker and a live "who this wakes" line.
// Typing `@` lists the thread's members (and `everyone`), filtered as you type; Enter or Tab
// inserts the exact name with a trailing space, so a stray space or a typo cannot quietly turn a
// mention into "no mention" (which the Gateway routes by its own rule). While the picker is open,
// Enter picks rather than sends.

import type { BotId, GroupRouting } from "@deskmates/contracts";
import { useAutoSizeTextarea } from "@deskmates/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import {
  type ActiveMention,
  type MentionMember,
  type UnaddressedRoute,
  activeMention,
  applyMention,
  mentionOptions,
  previewMentions,
  unaddressedRoute,
} from "./mention-query.js";

export interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter without Shift, outside an IME composition, with the picker closed. */
  onSubmit: () => void;
  members: readonly MentionMember[];
  /** How the Gateway routes a message with no mention; undefined is an older Gateway (walk). */
  groupRouting?: GroupRouting | undefined;
  /** The thread's owner, offered an unaddressed message first under `owner-v1`. */
  ownerBotId?: BotId | undefined;
  placeholder?: string;
  "aria-label"?: string;
  /**
   * The composer's actions (the send button). Given, the "who this wakes" line shows in a slot
   * beside them that exists while the box is empty too, so the first character typed fills a
   * row that is already there instead of adding one and moving the box (#111).
   */
  footer?: ReactNode;
}

export function MentionTextarea(props: MentionTextareaProps) {
  const { value, onChange, onSubmit, members, groupRouting, ownerBotId } = props;
  const t = useT();
  const ref = useAutoSizeTextarea(value);

  const [caret, setCaret] = useState(value.length);
  const [index, setIndex] = useState(0);
  /** The `@` position the user closed with Escape; the picker stays shut for that token. */
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(undefined);
  const pendingCaret = useRef<number | undefined>(undefined);

  const mention: ActiveMention | undefined = activeMention(value, caret);
  const options = mention ? mentionOptions(members, mention.query) : [];
  const open = mention !== undefined && options.length > 0 && dismissedAt !== mention.start;
  const preview = useMemo(() => previewMentions(value, members), [value, members]);
  const unaddressed = unaddressedRoute(members, groupRouting, ownerBotId);

  useEffect(() => {
    if (index >= options.length) setIndex(0);
  }, [index, options.length]);

  useEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== undefined) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = undefined;
    }
  });

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? value.length);

  const pick = (name: string) => {
    if (!mention) return;
    const next = applyMention(value, mention, caret, name);
    pendingCaret.current = next.caret;
    setIndex(0);
    onChange(next.text);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition ends on Enter: that keystroke commits the candidate and must not also
    // pick or send. `isComposing` is the modern signal, keyCode 229 the legacy one.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[index] ?? options[0] ?? "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAt(mention?.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const previewLine =
    value.trim() !== "" ? <MentionPreviewLine preview={preview} unaddressed={unaddressed} /> : null;

  return (
    <div className="mention-input">
      <textarea
        ref={ref}
        aria-label={props["aria-label"]}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? "mention-options" : undefined}
        aria-activedescendant={open ? `mention-option-${index}` : undefined}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setDismissedAt(undefined);
          onChange(e.target.value);
        }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") && !open) syncCaret();
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={props.placeholder}
      />
      {open ? (
        // Combobox pattern: focus stays in the textarea and the arrow keys move the active option
        // (aria-activedescendant), so a native <select> cannot replace this list.
        <div
          className="mention-menu"
          id="mention-options"
          // biome-ignore lint/a11y/useSemanticElements: listbox of a textarea combobox, see above
          role="listbox"
          aria-label={t("mentionTextarea.menuLabel")}
          tabIndex={-1}
        >
          {options.map((name, i) => (
            <div
              key={name}
              id={`mention-option-${i}`}
              // biome-ignore lint/a11y/useSemanticElements: option of the combobox listbox above
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              className={i === index ? "active" : undefined}
              onMouseDown={(e) => {
                // Keep focus in the textarea; a click would blur it before the pick.
                e.preventDefault();
                pick(name);
              }}
              onMouseEnter={() => setIndex(i)}
            >
              @{name}
            </div>
          ))}
        </div>
      ) : null}
      {props.footer !== undefined ? (
        <div className="composer-footer">
          <div className="mention-preview-slot">{previewLine}</div>
          {props.footer}
        </div>
      ) : (
        previewLine
      )}
    </div>
  );
}

function MentionPreviewLine({
  preview,
  unaddressed,
}: {
  preview: ReturnType<typeof previewMentions>;
  unaddressed: UnaddressedRoute;
}) {
  const t = useT();
  const wakes = preview.everyone
    ? t("mentionTextarea.wakesEveryone")
    : preview.woken.length > 0
      ? t("mentionTextarea.wakes", { names: preview.woken.map((n) => `@${n}`).join(", ") })
      : unaddressed.line;
  return (
    <p className="mention-preview" aria-live="polite">
      <span>{wakes}</span>
      {preview.unknown.length > 0 ? (
        <span className="warning">
          {" "}
          {t("mentionTextarea.unknown", {
            names: preview.unknown.map((n) => `@${n}`).join(", "),
          })}
          {preview.woken.length === 0 && !preview.everyone
            ? unaddressed.warning
            : t("mentionTextarea.onlyRecognized")}
        </span>
      ) : null}
    </p>
  );
}
