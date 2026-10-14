import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

function fitDraft(field: HTMLTextAreaElement) {
  field.style.height = "0px";
  const limit = Number.parseFloat(getComputedStyle(field).maxHeight) || 160;
  field.style.height = `${Math.min(field.scrollHeight, limit)}px`;
}

export interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string) => void;
  label?: string;
  placeholder?: string;
  context?: ReactNode;
  disabled?: boolean;
}

/** Controlled multiline chat composition. Sending has no effects beyond the callback. */
export function MessageComposer({
  value,
  onChange,
  onSend,
  label = "Message",
  placeholder = "What would you like to work on?",
  context,
  disabled = false,
}: MessageComposerProps) {
  const field = useAutoSizeTextarea(value);
  return (
    <form
      className="gb-message-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !value.trim()) return;
        onSend(value.trim());
        onChange("");
      }}
    >
      <textarea
        ref={field}
        aria-label={label}
        placeholder={placeholder}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="gb-message-composer-toolbar">
        <div className="gb-message-composer-context">{context}</div>
        <Button
          type="submit"
          variant="primary"
          size="icon"
          aria-label="Send message"
          disabled={disabled || !value.trim()}
        >
          <Icon name="send" />
        </Button>
      </div>
    </form>
  );
}

export function useAutoSizeTextarea(value: string) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (field.current?.value === value) fitDraft(field.current);
  }, [value]);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitDraft(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return field;
}
