import { Avatar } from "@deskmates/ui";
import { useT } from "../i18n/i18n-provider.js";

/**
 * The signed-in identity. Avatar and name open Account settings (issue #26) in the expanded
 * sidebar, the collapsed icon rail and the mobile header alike.
 */
export function SignedInUser({
  name,
  description,
  avatarUrl,
  current = false,
}: {
  name: string;
  description: string;
  /** The person's uploaded photo; absent for the name-based fallback. */
  avatarUrl?: string | null | undefined;
  /** Account settings is the page on screen. */
  current?: boolean;
}) {
  const t = useT();
  return (
    <div className="account-menu">
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
    </div>
  );
}
