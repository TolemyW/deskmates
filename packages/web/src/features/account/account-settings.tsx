// `#/account`: the signed-in person's own settings (ADR-0022 amendment 3, issue #26). Profile
// (photo and display name) and password are separate forms with separate actions; Preferences
// (language, appearance) and Sign out are here too, so the sidebar footer holds only the identity
// link that opens this page. Every call acts on this session's own account; the Gateway enforces
// that. Password fields live only in component state, are cleared after every attempt and on
// leaving, and are never stored.

import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AuthenticatedSessionView,
  type AvatarContentType,
  DISPLAY_NAME_MAX_LENGTH,
  type ProfileView,
  type UiLocale,
  isAvatarContentType,
} from "@deskmates/contracts";
import { Avatar, Select } from "@deskmates/ui";
import { Eye, EyeOff } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { AccountClient } from "../../api/account-client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { useT } from "../../i18n/i18n-provider.js";
import { LanguageControl } from "../../i18n/language-control.js";
import type { ThemePreference } from "../../lib/theme.js";
import { accountHref, agentAccessHref, workspacesHref } from "./route.js";

type T = ReturnType<typeof useT>;

/** A chosen photo, checked and ready to upload. */
interface PendingPhoto {
  blob: Blob;
  type: AvatarContentType;
  preview: string | null;
}

const AVATAR_EDGE_PX = 512;

/**
 * Check a chosen file, and shrink a large photo in the browser when it can. The Gateway checks
 * type, signature and size again; this only spares a round trip and explains the problem.
 */
export async function prepareAvatar(file: File, t: T): Promise<PendingPhoto> {
  if (!isAvatarContentType(file.type)) throw new Error(t("account.photo.error.type"));
  let blob: Blob = file;
  let type: AvatarContentType = file.type;
  if (file.size > AVATAR_MAX_BYTES) {
    const shrunk = await shrink(file).catch(() => undefined);
    if (!shrunk || shrunk.size > AVATAR_MAX_BYTES)
      throw new Error(t("account.photo.error.size", { kb: AVATAR_MAX_BYTES / 1024 }));
    blob = shrunk;
    type = "image/jpeg";
  }
  const preview = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  return { blob, type, preview };
}

/** Redraw a photo at most 512px on its longer edge as a JPEG; undefined where unsupported. */
async function shrink(file: File): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, AVATAR_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob ?? undefined), "image/jpeg", 0.88),
  );
}

function failure(err: unknown, t: T): string {
  if (err instanceof ApiError && err.status === 413)
    return t("account.photo.error.size", { kb: AVATAR_MAX_BYTES / 1024 });
  if (err instanceof ApiError && err.status === 400) return err.message;
  return t("account.error.generic");
}

/** Language and appearance as the shell holds them; the shell stores each change. */
export interface PreferenceControls {
  locale: UiLocale;
  /** Applies at once and is stored as this person's preference (`PATCH /auth/preferences`). */
  onLocaleChange: (locale: UiLocale) => void;
  theme: ThemePreference;
  /** Kept in this browser only. */
  onThemeChange: (theme: ThemePreference) => void;
}

export function AccountSettingsScreen({
  session,
  client,
  onProfile,
  onSessionRotated,
  preferences,
  onSignOut,
  page = "personal",
  workspaces,
}: {
  session: AuthenticatedSessionView;
  client: AccountClient;
  /** The profile after a change the Gateway stored. */
  onProfile: (profile: ProfileView) => void;
  /** The rotated session `POST /auth/password` returned; its CSRF token replaces the old one. */
  onSessionRotated: (view: AuthenticatedSessionView) => void;
  preferences: PreferenceControls;
  /** End this session (`POST /auth/logout`) or every session (`POST /auth/logout-all`). */
  onSignOut: (everywhere: boolean) => void;
  /** Which of the three User Settings pages is open (ADR-0034 decision 7). */
  page?: SettingsPage;
  /** The Workspaces page, rendered by the workspaces feature. */
  workspaces?: ReactNode;
}) {
  const t = useT();
  const intro =
    page === "agent-access"
      ? t("account.agentPage.intro")
      : page === "workspaces"
        ? t("account.workspacesPage.intro")
        : t("account.intro");
  return (
    <section
      className={`account-screen page page-container${page === "workspaces" ? "" : " page-container--narrow"}`}
      aria-labelledby="account-title"
    >
      <header className="costs-header">
        <div>
          <h1 id="account-title">{t("account.title")}</h1>
          <p>{intro}</p>
        </div>
      </header>
      <div className="settings-layout">
        <SettingsNav page={page} />
        <div className="settings-content">
          {page === "agent-access" ? (
            <AgentAccessSection session={session} client={client} />
          ) : page === "workspaces" ? (
            workspaces
          ) : (
            <>
              <ProfileSection session={session} client={client} onProfile={onProfile} />
              <PasswordSection
                session={session}
                client={client}
                onSessionRotated={onSessionRotated}
              />
              <PreferencesSection {...preferences} />
              <SignOutSection onSignOut={onSignOut} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export type SettingsPage = "personal" | "agent-access" | "workspaces";

/**
 * The three pages: a left list on a wide screen, a compact row of links on a narrow one. Each is
 * an address, so Back, reload and links land on the same page.
 */
function SettingsNav({ page }: { page: SettingsPage }) {
  const t = useT();
  const entries: Array<[SettingsPage, string, string]> = [
    ["personal", accountHref(), t("account.nav.personal")],
    ["agent-access", agentAccessHref(), t("account.nav.agentAccess")],
    ["workspaces", workspacesHref(), t("account.nav.workspaces")],
  ];
  return (
    <nav className="settings-nav" aria-label={t("account.nav.label")}>
      {entries.map(([key, href, label]) => (
        <a
          key={key}
          href={href}
          className={`settings-nav-link${key === page ? " active" : ""}`}
          aria-current={key === page ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/** Language and appearance (formerly the sidebar's Settings gear). Every role has them. */
function PreferencesSection({ locale, onLocaleChange, theme, onThemeChange }: PreferenceControls) {
  const t = useT();
  return (
    <section className="card account-section" aria-labelledby="account-preferences-title">
      <h2 id="account-preferences-title">{t("account.preferences.title")}</h2>
      <p className="account-explainer">{t("account.preferences.intro")}</p>
      <div className="account-preferences">
        <div className="preferences-field">
          <span aria-hidden="true">{t("app.language.label")}</span>
          <LanguageControl locale={locale} onChange={onLocaleChange} />
        </div>
        <div className="preferences-field">
          <span aria-hidden="true">{t("account.preferences.appearance")}</span>
          <Select
            aria-label={t("account.preferences.appearance")}
            value={theme}
            onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "system") onThemeChange(value);
            }}
            options={[
              { value: "system", label: t("account.preferences.system") },
              { value: "light", label: t("account.preferences.light") },
              { value: "dark", label: t("account.preferences.dark") },
            ]}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Sign out of this browser, or of every device. The shell unmounts the signed-in UI, asks the
 * Gateway to end the session(s), and shows the sign-in page; an already-ended session counts as
 * signed out. Every browser session has a person, so every session reaches this page.
 */
function SignOutSection({ onSignOut }: { onSignOut: (everywhere: boolean) => void }) {
  const t = useT();
  return (
    <section className="card account-section" aria-labelledby="account-sign-out-title">
      <h2 id="account-sign-out-title">{t("account.signOut.title")}</h2>
      <p className="account-explainer">{t("account.signOut.intro")}</p>
      <div className="account-actions">
        <Button variant="outline" type="button" onClick={() => onSignOut(false)}>
          {t("account.signOut.submit")}
        </Button>
        <Button variant="danger-soft" type="button" onClick={() => onSignOut(true)}>
          {t("account.signOut.everywhere")}
        </Button>
      </div>
    </section>
  );
}

/** The public file of the build an agent installs as its Deskmates skill. */
export const AGENT_SKILL_PATH = "/agent-skill/SKILL.md";

/** Copy on an explicit click only; report whether the browser let it happen. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Connect an agent": the prompt a person pastes into an agent they run (Claude Code or any agent
 * that reads skills) so it installs the Deskmates skill. Credentials are deliberately a separate
 * flow: an Admin or Owner creates the token here (`POST /api/service-principals`, ADR-0022
 * amendment 2), and the one-time token lives only in component state and its own copy control.
 * It never enters the copied prompt or browser storage (issue #51).
 */
function AgentAccessSection({
  session,
  client,
}: {
  session: AuthenticatedSessionView;
  client: AccountClient;
}) {
  const t = useT();
  const manager = session.tenant.role === "owner" || session.tenant.role === "admin";
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [tokenCopied, setTokenCopied] = useState<"idle" | "copied" | "failed">("idle");
  // Clear the token when the screen is left, like the password fields.
  useEffect(() => () => setToken(null), []);

  const origin = window.location.origin;
  const prompt = t("account.agent.prompt", {
    url: origin,
    skillUrl: `${origin}${AGENT_SKILL_PATH}`,
  });

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopied("idle");
    try {
      const issued = await client.createAgentToken(
        t("account.agent.tokenName", { name: session.user.displayName }),
      );
      setToken(issued.token);
      setTokenCopied("idle");
    } catch {
      setError(t("account.agent.error"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    setCopied((await copyText(prompt)) ? "copied" : "failed");
  };

  return (
    <section className="card account-section" aria-labelledby="account-agent-title">
      <h2 id="account-agent-title">{t("account.agent.title")}</h2>
      <p className="account-explainer">{t("account.agent.intro")}</p>
      <p className="account-explainer">{t("account.agent.role")}</p>
      {manager ? (
        token === null ? (
          <div className="account-actions">
            <Button variant="primary" type="button" disabled={busy} onClick={() => void create()}>
              {busy ? t("account.agent.creating") : t("account.agent.create")}
            </Button>
          </div>
        ) : (
          <div className="agent-token" aria-label={t("account.agent.tokenLabel")}>
            <output className="account-notice">{t("account.agent.once")}</output>
            <code className="handoff-secret">{token}</code>
            <p className="account-explainer">{t("account.agent.secretEntry")}</p>
            <div className="account-actions">
              <Button
                variant="outline"
                type="button"
                onClick={async () => setTokenCopied((await copyText(token)) ? "copied" : "failed")}
              >
                {t("account.agent.copyToken")}
              </Button>
              {tokenCopied === "copied" ? (
                <output className="account-notice">{t("account.agent.tokenCopied")}</output>
              ) : tokenCopied === "failed" ? (
                <p role="alert" className="error">
                  {t("account.agent.copyFailed")}
                </p>
              ) : null}
            </div>
          </div>
        )
      ) : (
        <small>{t("account.agent.memberHint")}</small>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <pre className="agent-prompt" aria-label={t("account.agent.promptLabel")}>
        {prompt}
      </pre>
      <div className="account-actions">
        <Button variant="outline" type="button" onClick={() => void copy()}>
          {t("account.agent.copy")}
        </Button>
        {copied === "copied" ? (
          <output className="account-notice">{t("account.agent.copied")}</output>
        ) : copied === "failed" ? (
          <p role="alert" className="error">
            {t("account.agent.copyFailed")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ProfileSection({
  session,
  client,
  onProfile,
}: {
  session: AuthenticatedSessionView;
  client: AccountClient;
  onProfile: (profile: ProfileView) => void;
}) {
  const t = useT();
  const saved = session.user.displayName;
  const [name, setName] = useState(saved);
  const [nameError, setNameError] = useState<string>();
  const [nameNotice, setNameNotice] = useState<string>();
  const [savingName, setSavingName] = useState(false);
  const [photo, setPhoto] = useState<PendingPhoto>();
  const [photoError, setPhotoError] = useState<string>();
  const [photoNotice, setPhotoNotice] = useState<string>();
  const [savingPhoto, setSavingPhoto] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const loginName = session.account?.localLoginName ?? session.user.loginName;
  const dirty = name !== saved;

  // A preview URL is released when it is replaced or the screen goes away.
  useEffect(() => {
    const url = photo?.preview;
    return () => {
      if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    };
  }, [photo?.preview]);

  const saveName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    setNameNotice(undefined);
    if (!trimmed) return setNameError(t("account.name.error.required"));
    if ([...trimmed].length > DISPLAY_NAME_MAX_LENGTH)
      return setNameError(t("account.name.error.length", { max: DISPLAY_NAME_MAX_LENGTH }));
    setSavingName(true);
    setNameError(undefined);
    try {
      const profile = await client.updateDisplayName(trimmed);
      onProfile(profile);
      setName(profile.displayName);
      setNameNotice(t("account.name.saved"));
    } catch (err) {
      // The edit stays in the field so it can be corrected or retried.
      setNameError(failure(err, t));
    } finally {
      setSavingName(false);
    }
  };

  const choose = async (file: File | undefined): Promise<void> => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    setPhotoNotice(undefined);
    try {
      setPhoto(await prepareAvatar(file, t));
      setPhotoError(undefined);
    } catch (err) {
      setPhoto(undefined);
      setPhotoError(err instanceof Error ? err.message : String(err));
    }
  };

  const savePhoto = async (): Promise<void> => {
    if (!photo) return;
    setSavingPhoto(true);
    setPhotoError(undefined);
    try {
      onProfile(await client.uploadAvatar(photo.blob, photo.type));
      setPhoto(undefined);
      setPhotoNotice(t("account.photo.saved"));
      changeButton.current?.focus();
    } catch (err) {
      // The previous photo stays; the chosen one stays previewed for a retry.
      setPhotoError(failure(err, t));
    } finally {
      setSavingPhoto(false);
    }
  };

  const removePhoto = async (): Promise<void> => {
    setSavingPhoto(true);
    setPhotoError(undefined);
    setPhotoNotice(undefined);
    try {
      onProfile(await client.removeAvatar());
      setPhotoNotice(t("account.photo.removed"));
      changeButton.current?.focus();
    } catch (err) {
      setPhotoError(failure(err, t));
    } finally {
      setSavingPhoto(false);
    }
  };

  return (
    <section className="card account-section" aria-labelledby="account-profile-title">
      <h2 id="account-profile-title">{t("account.profile.title")}</h2>
      <div className="account-photo">
        <Avatar
          name={name.trim() || saved}
          size="lg"
          src={photo?.preview ?? session.user.avatarUrl ?? null}
        />
        <div className="account-photo-actions">
          <input
            ref={fileInput}
            id="account-photo-file"
            hidden
            type="file"
            accept={AVATAR_CONTENT_TYPES.join(",")}
            aria-label={t("account.photo.file")}
            tabIndex={-1}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          {photo ? (
            <>
              <Button
                variant="primary"
                type="button"
                disabled={savingPhoto}
                onClick={() => void savePhoto()}
              >
                {savingPhoto ? t("account.saving") : t("account.photo.save")}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={savingPhoto}
                onClick={() => {
                  setPhoto(undefined);
                  setPhotoError(undefined);
                  changeButton.current?.focus();
                }}
              >
                {t("account.photo.discard")}
              </Button>
            </>
          ) : (
            <>
              <Button
                ref={changeButton}
                variant="outline"
                type="button"
                disabled={savingPhoto}
                onClick={() => fileInput.current?.click()}
              >
                {t("account.photo.change")}
              </Button>
              {session.user.avatarUrl ? (
                <Button
                  variant="ghost"
                  type="button"
                  disabled={savingPhoto}
                  onClick={() => void removePhoto()}
                >
                  {t("account.photo.remove")}
                </Button>
              ) : null}
            </>
          )}
          <small>
            {photo
              ? t("account.photo.previewHint")
              : t("account.photo.hint", { kb: AVATAR_MAX_BYTES / 1024 })}
          </small>
        </div>
      </div>
      {photoError ? (
        <p role="alert" className="error">
          {photoError}
        </p>
      ) : photoNotice ? (
        <output className="account-notice">{photoNotice}</output>
      ) : null}
      <form className="account-form" onSubmit={saveName} noValidate>
        <label htmlFor="account-display-name">{t("account.name.label")}</label>
        <Input
          id="account-display-name"
          name="name"
          autoComplete="name"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={name}
          disabled={savingName}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "account-display-name-error" : "account-display-name-hint"}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(undefined);
            setNameNotice(undefined);
          }}
        />
        {nameError ? (
          <p id="account-display-name-error" role="alert" className="error">
            {nameError}
          </p>
        ) : (
          <small id="account-display-name-hint">
            {dirty ? t("account.name.unsaved") : t("account.name.hint")}
          </small>
        )}
        {nameNotice ? <output className="account-notice">{nameNotice}</output> : null}
        <div className="account-actions">
          <Button variant="primary" type="submit" disabled={!dirty || savingName}>
            {savingName ? t("account.saving") : t("account.name.save")}
          </Button>
          <Button
            variant="outline"
            type="button"
            disabled={!dirty || savingName}
            onClick={() => {
              setName(saved);
              setNameError(undefined);
            }}
          >
            {t("account.name.cancel")}
          </Button>
        </div>
      </form>
      <dl className="account-facts">
        <div>
          <dt>{t("account.loginName.label")}</dt>
          {loginName ? (
            <dd>
              <code>{loginName}</code>
            </dd>
          ) : (
            <dd>{t("account.loginName.none")}</dd>
          )}
        </div>
      </dl>
      <small>{t("account.loginName.hint")}</small>
    </section>
  );
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="account-password-field">
      <label htmlFor={id}>{label}</label>
      <div className="account-password-input">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={
            visible
              ? t("account.password.hide", { field: label })
              : t("account.password.show", { field: label })
          }
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function PasswordSection({
  session,
  client,
  onSessionRotated,
}: {
  session: AuthenticatedSessionView;
  client: AccountClient;
  onSessionRotated: (view: AuthenticatedSessionView) => void;
}) {
  const t = useT();
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    field: "current" | "next" | "confirm" | "form";
    text: string;
  }>();
  const [done, setDone] = useState(false);
  // Older Gateways send no capability; only then is the session's login name the hint.
  const capability =
    session.account?.password ?? (session.user.loginName ? "available" : "identity_provider");

  const clear = (): void => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };
  // Leaving the screen unmounts this form, which drops whatever was typed with its state.

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setDone(false);
    if (!current) return setError({ field: "current", text: t("account.password.error.current") });
    if (!next) return setError({ field: "next", text: t("account.password.error.new") });
    if (next !== confirm)
      return setError({ field: "confirm", text: t("account.password.error.mismatch") });
    setBusy(true);
    setError(undefined);
    try {
      const rotated = await client.changePassword(current, next);
      clear();
      setDone(true);
      onSessionRotated(rotated);
    } catch (err) {
      clear();
      if (err instanceof ApiError && err.status === 403)
        setError({ field: "current", text: t("account.password.error.incorrect") });
      else if (err instanceof ApiError && err.status === 400)
        setError({ field: "next", text: err.message });
      else if (err instanceof ApiError && err.status === 429)
        setError({ field: "form", text: t("account.password.error.tooMany") });
      else if (err instanceof ApiError && err.status === 409)
        setError({ field: "form", text: t("account.password.error.changedElsewhere") });
      else setError({ field: "form", text: t("account.error.generic") });
    } finally {
      setBusy(false);
    }
  };

  const errorId = `${id}-error`;
  const fieldError = (field: "current" | "next" | "confirm") =>
    error?.field === field ? (
      <p id={errorId} role="alert" className="error">
        {error.text}
      </p>
    ) : null;

  return (
    <section className="card account-section" aria-labelledby="account-password-title">
      <h2 id="account-password-title">{t("account.password.title")}</h2>
      {capability === "identity_provider" ? (
        <p className="account-explainer">{t("account.password.identityProvider")}</p>
      ) : capability === "sign_in_with_password" ? (
        <p className="account-explainer">
          {t("account.password.signInWithPassword", {
            loginName: session.account?.localLoginName ?? "",
          })}
        </p>
      ) : (
        <form className="account-form" onSubmit={submit} noValidate>
          {/* Lets a password manager pair the new password with this account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={session.account?.localLoginName ?? session.user.loginName ?? ""}
            readOnly
            hidden
          />
          <PasswordField
            id={`${id}-current`}
            label={t("account.password.current")}
            value={current}
            onChange={(value) => {
              setCurrent(value);
              setDone(false);
            }}
            autoComplete="current-password"
            disabled={busy}
            invalid={error?.field === "current"}
            {...(error?.field === "current" ? { describedBy: errorId } : {})}
          />
          {fieldError("current")}
          <PasswordField
            id={`${id}-new`}
            label={t("account.password.new")}
            value={next}
            onChange={(value) => {
              setNext(value);
              setDone(false);
            }}
            autoComplete="new-password"
            disabled={busy}
            invalid={error?.field === "next"}
            {...(error?.field === "next" ? { describedBy: errorId } : {})}
          />
          {fieldError("next")}
          <PasswordField
            id={`${id}-confirm`}
            label={t("account.password.confirm")}
            value={confirm}
            onChange={(value) => {
              setConfirm(value);
              setDone(false);
            }}
            autoComplete="new-password"
            disabled={busy}
            invalid={error?.field === "confirm"}
            {...(error?.field === "confirm" ? { describedBy: errorId } : {})}
          />
          {fieldError("confirm")}
          {error?.field === "form" ? (
            <p role="alert" className="error">
              {error.text}
            </p>
          ) : null}
          {done ? (
            <output className="account-notice">{t("account.password.changed")}</output>
          ) : (
            <small>{t("account.password.hint")}</small>
          )}
          <div className="account-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? t("account.saving") : t("account.password.submit")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
