import { useEffect, useRef } from "react";

/** Focus the opened editor, then return to its Change button after cancel or a saved edit. */
export function useEditorFocus(editing: boolean) {
  const form = useRef<HTMLFormElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLInputElement>("input:not([hidden])")?.focus();
    else if (wasEditing.current) button.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  return { form, button };
}
