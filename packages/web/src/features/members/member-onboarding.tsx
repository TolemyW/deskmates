// Adding people on the People screen (ADR-0022 amendment 4, issue #25): two clearly named paths.
// **Invite by link** (recommended) makes a single-use link; whoever opens it chooses their own
// username and password, or joins with an account they have. **Create account** lets an Admin
// choose the username; the Gateway generates an initial password that is shown once here, in
// component state only, and is gone when the panel closes. The Gateway enforces every rule.

import type {
  CreatedAccountView,
  CreatedInvitationView,
  InvitableRole,
  InvitationView,
  SsoProviderView,
} from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { MembersClient } from "../../api/members-client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { errorMessage } from "../../format.js";
import { useLocale, useT } from "../../i18n/i18n-provider.js";

type Mode = "invite" | "create" | undefined;
type CopyState = "idle" | "copied" | "failed";

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

function CopyStatus({ state }: { state: CopyState }) {
  const t = useT();
  if (state === "idle") return null;
  return state === "copied" ? (
    <output className="account-notice">{t("members.copy.done")}</output>
  ) : (
    <p role="alert" className="error">
      {t("members.copy.failed")}
    </p>
  );
}

export function MemberOnboarding({
  client,
  tenantName,
  canInviteAdmin,
  workspaceId,
  ssoProviders,
  busy,
  onChanged,
  hint,
}: {
  client: MembersClient;
  tenantName: string;
  /** Owners and Admins may invite or create Admins (ADR-0022 amendment 6 W4). */
  canInviteAdmin: boolean;
  /** The workspace the role is granted in; every invitation and account names it (W9). */
  workspaceId?: string | undefined;
  ssoProviders: SsoProviderView[];
  busy: boolean;
  /** Reload members and invitations after a change. */
  onChanged: () => Promise<void>;
  /** The "nobody else yet" guidance, when it applies. */
  hint?: ReactNode;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>();
  const [created, setCreated] = useState<CreatedInvitationView>();
  const [account, setAccount] = useState<CreatedAccountView>();
  const inviteButton = useRef<HTMLButtonElement>(null);
  const roleOptions = [
    { value: "member", label: t("members.roleOption.member") },
    { value: "guest", label: t("members.roleOption.guest") },
    canInviteAdmin ? { value: "admin", label: t("members.roleOption.admin") } : null,
  ];
  const close = (): void => {
    setMode(undefined);
    inviteButton.current?.focus();
  };

  return (
    <div className="onboarding">
      <p className="muted small">{t("members.onboard.intro")}</p>
      {hint}
      <div className="onboarding-actions">
        <Button
          ref={inviteButton}
          // The recommended path stays the primary action unless Create account is open.
          variant={mode === "create" ? "outline" : "primary"}
          type="button"
          aria-expanded={mode === "invite"}
          aria-controls="onboarding-invite"
          onClick={() => {
            setMode(mode === "invite" ? undefined : "invite");
            setAccount(undefined);
          }}
        >
          {t("members.onboard.inviteByLink")}
        </Button>
        <Button
          variant={mode === "create" ? "primary" : "outline"}
          type="button"
          aria-expanded={mode === "create"}
          aria-controls="onboarding-create"
          onClick={() => {
            setMode(mode === "create" ? undefined : "create");
            setCreated(undefined);
          }}
        >
          {t("members.onboard.createAccount")}
        </Button>
        <span className="muted small">{t("members.onboard.recommended")}</span>
      </div>
      {mode === "invite" ? (
        <InviteByLinkForm
          client={client}
          tenantName={tenantName}
          roleOptions={roleOptions}
          workspaceId={workspaceId}
          ssoProviders={ssoProviders}
          busy={busy}
          onCreated={async (view) => {
            setCreated(view);
            setMode(undefined);
            await onChanged();
          }}
          onCancel={close}
        />
      ) : null}
      {mode === "create" ? (
        <CreateAccountForm
          client={client}
          roleOptions={roleOptions}
          workspaceId={workspaceId}
          busy={busy}
          onCreated={async (view) => {
            setAccount(view);
            setMode(undefined);
            await onChanged();
          }}
          onCancel={close}
        />
      ) : null}
      {created ? (
        <InvitationLinkPanel
          created={created}
          tenantName={tenantName}
          onDone={() => {
            setCreated(undefined);
            inviteButton.current?.focus();
          }}
        />
      ) : null}
      {account ? (
        <LoginHandoffPanel
          account={account}
          onDone={() => {
            setAccount(undefined);
            inviteButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function InviteByLinkForm({
  client,
  tenantName,
  roleOptions,
  workspaceId,
  ssoProviders,
  busy,
  onCreated,
  onCancel,
}: {
  client: MembersClient;
  tenantName: string;
  roleOptions: Array<{ value: string; label: string } | null>;
  workspaceId: string | undefined;
  ssoProviders: SsoProviderView[];
  busy: boolean;
  onCreated: (view: CreatedInvitationView) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [role, setRole] = useState<InvitableRole>("member");
  const [method, setMethod] = useState<"password" | "sso">("password");
  const [providerId, setProviderId] = useState(ssoProviders[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (method === "sso" && !email.trim()) return setError(t("members.invite.error.email"));
    setWorking(true);
    setError(undefined);
    try {
      const target =
        method === "sso"
          ? { kind: "oidc_email" as const, providerId, email: email.trim() }
          : { kind: "local_signup" as const };
      await onCreated(
        await client.createInvitation({
          role,
          target,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        }),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.details.reason === "sso_required"
          ? t("members.error.ssoRequired")
          : errorMessage(err),
      );
    } finally {
      setWorking(false);
    }
  };
  return (
    <form
      id="onboarding-invite"
      className="onboarding-form"
      onSubmit={submit}
      aria-labelledby="onboarding-invite-title"
    >
      <h3 id="onboarding-invite-title">{t("members.onboard.inviteByLink")}</h3>
      <p className="muted small">
        {method === "sso"
          ? t("members.invite.ssoExplain")
          : t("members.invite.explain", { tenant: tenantName })}
      </p>
      <Select
        label={t("members.invite.role")}
        value={role}
        disabled={busy || working}
        onValueChange={(value) => setRole(value as InvitableRole)}
        options={roleOptions}
      />
      {ssoProviders.length > 0 ? (
        <Select
          label={t("members.invite.method")}
          value={method}
          disabled={busy || working}
          onValueChange={(value) => setMethod(value as "password" | "sso")}
          options={[
            { value: "password", label: t("members.invite.method.password") },
            { value: "sso", label: t("members.invite.method.sso") },
          ]}
        />
      ) : null}
      {method === "sso" ? (
        <>
          <Select
            label={t("members.invite.provider")}
            value={providerId}
            disabled={busy || working}
            onValueChange={(value) => setProviderId(value)}
            options={ssoProviders.map((provider) => ({
              value: provider.id,
              label: provider.displayName,
            }))}
          />
          <label htmlFor="invite-email">
            {t("members.invite.email")}
            <Input
              id="invite-email"
              type="email"
              value={email}
              disabled={busy || working}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="account-actions">
        <Button variant="primary" type="submit" disabled={busy || working}>
          {t("members.invite.create")}
        </Button>
        <Button variant="outline" type="button" disabled={working} onClick={onCancel}>
          {t("members.onboard.cancel")}
        </Button>
      </div>
    </form>
  );
}

function InvitationLinkPanel({
  created,
  tenantName,
  onDone,
}: {
  created: CreatedInvitationView;
  tenantName: string;
  onDone: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [copy, setCopy] = useState<CopyState>("idle");
  // The Gateway returns a path on this site (`/#/invite/<token>`).
  const link = new URL(created.link, window.location.origin).href;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="handoff-panel" aria-labelledby="invitation-ready-title">
      <h3 id="invitation-ready-title" ref={heading} tabIndex={-1}>
        {t("members.invite.ready")}
      </h3>
      <dl className="handoff-facts">
        <div>
          <dt>{t("members.handoff.team")}</dt>
          <dd>{tenantName}</dd>
        </div>
        <div>
          <dt>{t("members.invite.role")}</dt>
          <dd>
            {created.invitation.role === "admin"
              ? t("members.roleOption.admin")
              : created.invitation.role === "guest"
                ? t("members.roleOption.guest")
                : t("members.roleOption.member")}
          </dd>
        </div>
        <div>
          <dt>{t("members.handoff.expires")}</dt>
          <dd>{new Date(created.invitation.expiresAt).toLocaleString(locale)}</dd>
        </div>
      </dl>
      <code className="handoff-secret">{link}</code>
      <p className="muted small">{t("members.invite.sendLink")}</p>
      <CopyStatus state={copy} />
      <div className="account-actions">
        <Button
          variant="primary"
          type="button"
          onClick={async () => setCopy((await copyText(link)) ? "copied" : "failed")}
        >
          {t("members.invite.copyLink")}
        </Button>
        <Button variant="outline" type="button" onClick={onDone}>
          {t("members.handoff.done")}
        </Button>
      </div>
    </section>
  );
}

function CreateAccountForm({
  client,
  roleOptions,
  workspaceId,
  busy,
  onCreated,
  onCancel,
}: {
  client: MembersClient;
  roleOptions: Array<{ value: string; label: string } | null>;
  workspaceId: string | undefined;
  busy: boolean;
  onCreated: (view: CreatedAccountView) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [loginName, setLoginName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!loginName.trim()) return setError(t("members.create.error.username"));
    setWorking(true);
    setError(undefined);
    try {
      await onCreated(
        await client.createAccount({
          loginName: loginName.trim(),
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          role,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        }),
      );
    } catch (err) {
      // The fields stay so the username can be corrected.
      setError(
        err instanceof ApiError && err.details.reason === "login_name_taken"
          ? t("members.create.error.taken")
          : err instanceof ApiError && err.details.reason === "sso_required"
            ? t("members.error.ssoRequired")
            : errorMessage(err),
      );
    } finally {
      setWorking(false);
    }
  };
  return (
    <form
      id="onboarding-create"
      className="onboarding-form"
      onSubmit={submit}
      aria-labelledby="onboarding-create-title"
      noValidate
    >
      <h3 id="onboarding-create-title">{t("members.onboard.createAccount")}</h3>
      <p className="muted small">{t("members.create.explain")}</p>
      <label htmlFor="create-username">
        {t("members.create.username")}
        <Input
          id="create-username"
          autoComplete="off"
          spellCheck={false}
          value={loginName}
          disabled={busy || working}
          onChange={(event) => setLoginName(event.target.value)}
        />
      </label>
      <label htmlFor="create-display-name">
        {t("members.create.displayName")}
        <Input
          id="create-display-name"
          autoComplete="off"
          value={displayName}
          disabled={busy || working}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <small className="muted">{t("members.create.displayNameHint")}</small>
      </label>
      <Select
        label={t("members.invite.role")}
        value={role}
        disabled={busy || working}
        onValueChange={(value) => setRole(value as InvitableRole)}
        options={roleOptions}
      />
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="account-actions">
        <Button variant="primary" type="submit" disabled={busy || working}>
          {t("members.create.submit")}
        </Button>
        <Button variant="outline" type="button" disabled={working} onClick={onCancel}>
          {t("members.onboard.cancel")}
        </Button>
      </div>
    </form>
  );
}

function LoginHandoffPanel({
  account,
  onDone,
}: {
  account: CreatedAccountView;
  onDone: () => void;
}) {
  const t = useT();
  const [copy, setCopy] = useState<CopyState>("idle");
  const signIn = `${window.location.origin}/`;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const details = t("members.handoff.copyText", {
    url: signIn,
    username: account.loginName,
    password: account.initialPassword,
  });
  return (
    <section className="handoff-panel" aria-labelledby="account-ready-title">
      <h3 id="account-ready-title" ref={heading} tabIndex={-1}>
        {t("members.handoff.title", { name: account.member.displayName })}
      </h3>
      <p className="muted small">{t("members.handoff.once")}</p>
      <dl className="handoff-facts">
        <div>
          <dt>{t("members.handoff.signIn")}</dt>
          <dd>
            <code>{signIn}</code>
          </dd>
        </div>
        <div>
          <dt>{t("members.create.username")}</dt>
          <dd>
            <code>{account.loginName}</code>
          </dd>
        </div>
        <div>
          <dt>{t("members.handoff.password")}</dt>
          <dd>
            <code className="handoff-secret">{account.initialPassword}</code>
          </dd>
        </div>
      </dl>
      <p className="muted small">{t("members.handoff.reminder")}</p>
      <CopyStatus state={copy} />
      <div className="account-actions">
        <Button
          variant="primary"
          type="button"
          onClick={async () => setCopy((await copyText(details)) ? "copied" : "failed")}
        >
          {t("members.handoff.copy")}
        </Button>
        <Button variant="outline" type="button" onClick={onDone}>
          {t("members.handoff.done")}
        </Button>
      </div>
    </section>
  );
}

/** What an invitation row names as its recipient. */
export function invitationRecipient(
  invitation: InvitationView,
  t: ReturnType<typeof useT>,
): string {
  const target = invitation.target;
  if (target.kind === "local_signup") return t("members.invitation.anyone");
  return target.kind === "oidc_email" ? target.email : target.loginName;
}
