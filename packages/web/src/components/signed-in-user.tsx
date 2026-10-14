import { Avatar } from "@deskmates/ui";
import { Users } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/i18n-provider.js";

/**
 * The signed-in identity. Avatar and name open Account settings (issue #26) in the expanded
 * sidebar, the collapsed icon rail and the mobile header alike. Team switching has its own control.
 */
export function SignedInUser({
  name,
  description,
  avatarUrl,
  current = false,
  canSwitchTeam,
  children,
}: {
  name: string;
  description: string;
  /** The person's uploaded photo; absent for the name-based fallback. */
  avatarUrl?: string | null | undefined;
  /** Account settings is the page on screen. */
  current?: boolean;
  canSwitchTeam: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !(event.target instanceof Element && event.target.closest('[data-gb-ui="select-popover"]'))
      )
        setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return (
    <div
      className="account-menu"
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget) &&
          !(
            event.relatedTarget instanceof Element &&
            event.relatedTarget.closest('[data-gb-ui="select-popover"]')
          )
        )
          setOpen(false);
      }}
    >
      <a
        href="#/account"
        className={`signed-in-user${current ? " active" : ""}`}
        aria-label={t("app.account.open", { name })}
        aria-current={current ? "page" : undefined}
        title={`${t("app.account.settings")} · ${name} · ${description}`}
      >
        <Avatar name={name} src={avatarUrl ?? null} />
        <div>
          <span className="signed-in-name">{name}</span>
          <span className="signed-in-role">{description}</span>
        </div>
      </a>
      {canSwitchTeam ? (
        <button
          type="button"
          className="icon-button team-menu-trigger"
          ref={trigger}
          aria-label={t("app.switchTeam")}
          title={t("app.switchTeam")}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          <Users size={16} aria-hidden="true" />
        </button>
      ) : null}
      {open ? (
        <dialog
          open
          className="account-panel"
          id={id}
          ref={panel}
          aria-label={t("app.switchTeam")}
          tabIndex={-1}
        >
          {children}
        </dialog>
      ) : null}
    </div>
  );
}
