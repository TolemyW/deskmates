// `#/vault` (ADR-0045): the selected workspace's credentials, used by its bots through references.
// A bot sees names and origins; a tool fills a password into the shared browser or adds a token to
// one fixed request, after an approval. Every Member reads this page; an Owner or Admin maintains
// it. The page never shows a saved value, and its forms keep a typed value only until the request
// is sent: inputs are cleared after every submission, never stored in the browser, a URL or a
// message (decision 2). The page says what the Vault does not do: hide a filled value from the
// workspace's own bots (decision 9), prove a sign-in (decision 8), or ask anyone in `approve_all`
// (decision 4).

import type {
  ApprovalMode,
  VaultEntry,
  VaultEntryType,
  VaultRequestDefinition,
  VaultRequestParam,
  VaultView,
} from "@deskmates/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import type { VaultApi } from "./api.js";

type Api = ApiClient & VaultApi;

/** Examples in the forms: identifiers, the same in every language. */
const ORIGIN_EXAMPLE = "https://accounts.example.com";
const BEARER_EXAMPLE = "Authorization: Bearer";

const MODE_NOTE: Record<ApprovalMode, MessageKey> = {
  manual: "vault.mode.manual",
  automatic: "vault.mode.automatic",
  approve_all: "vault.mode.approveAll",
};

/** `name in type [required]` per line, e.g. `id path string`; the definition editor's format. */
export function parseParams(text: string): VaultRequestParam[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", place = "query", type = "string", flag] = line.split(/\s+/);
      return {
        name,
        in: place as VaultRequestParam["in"],
        type: type as VaultRequestParam["type"],
        ...(flag === "required" || place === "path" ? { required: true } : {}),
      };
    });
}

export function formatParams(params: readonly VaultRequestParam[]): string {
  return params
    .map((p) => `${p.name} ${p.in} ${p.type}${p.required ? " required" : ""}`)
    .join("\n");
}

export function VaultScreen({ api }: { api: Api }) {
  const scope = useWorkspaceScope(api);
  const workspaceId = scope.current?.id;
  return <WorkspaceVault key={workspaceId ?? "none"} api={api} workspaceId={workspaceId} />;
}

function WorkspaceVault({ api, workspaceId }: { api: Api; workspaceId: string | undefined }) {
  const t = useT();
  const can = useCan("vault.manage", workspaceId);
  const [view, setView] = useState<VaultView>();
  const [creating, setCreating] = useState(false);
  const [about, setAbout] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const aboutTrigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const readSequence = useRef(0);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    const request = ++readSequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.getWorkspaceVault(workspaceId);
      if (request === readSequence.current) setView(next);
    } catch (err) {
      if (request === readSequence.current) setError(errorMessage(err));
    } finally {
      if (request === readSequence.current) setLoading(false);
    }
  }, [api, workspaceId]);
  useEffect(() => {
    setView(undefined);
    setCreating(false);
    void reload();
    return () => {
      readSequence.current += 1;
    };
  }, [reload]);

  /** Every change: run it, show its refusal, reread the catalog. */
  const act = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await work();
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace-screen resource-page page-container vault-page">
      <header className="resource-heading">
        <div className="resource-heading-text">
          <h1>{t("vault.title")}</h1>
          <p>{t("vault.summary")}</p>
        </div>
        {can.allowed && view?.available ? (
          <Button variant="default" ref={createTrigger} onClick={() => setCreating(true)}>
            {t("vault.create.title")}
          </Button>
        ) : null}
      </header>
      <div className="vault-notice">
        <div className="vault-policy">
          <p className="muted small" role="note">
            {t("vault.sharedNote")}
          </p>
          {view ? (
            <p
              className={view.approvalMode === "approve_all" ? "vault-mode-warning" : "muted small"}
              role={view.approvalMode === "approve_all" ? "alert" : undefined}
            >
              {t(MODE_NOTE[view.approvalMode])}
            </p>
          ) : null}
        </div>
        <Button ref={aboutTrigger} variant="tertiary" onClick={() => setAbout(true)}>
          {t("vault.about")}
        </Button>
      </div>
      <Dialog open={about} onOpenChange={setAbout}>
        <DialogContent
          className="vault-dialog max-w-lg overflow-y-auto"
          closeLabel={t("vault.cancel")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            aboutTrigger.current?.focus();
          }}
        >
          <DialogTitle>{t("vault.about")}</DialogTitle>
          <DialogDescription>{t("vault.intro")}</DialogDescription>
          <p className="vault-boundary">{t("vault.boundary")}</p>
          <p className="muted small">{t("vault.filledNote")}</p>
        </DialogContent>
      </Dialog>
      {view && !view.available ? (
        <p className="vault-mode-warning" role="alert">
          {t("vault.unavailable")}
        </p>
      ) : null}
      {error && !creating ? (
        <div className="error" role="alert">
          {error}
          <Button
            type="button"
            variant="outline"
            disabled={busy || loading}
            onClick={() => void reload()}
          >
            {t("vault.retry")}
          </Button>
        </div>
      ) : null}
      {!workspaceId ? (
        <p className="muted small">{t("vault.noWorkspace")}</p>
      ) : !view ? (
        error ? null : (
          <p className="muted small">{t("vault.loading")}</p>
        )
      ) : (
        <>
          {view.entries.length === 0 ? (
            <p className="muted small">{t("vault.empty")}</p>
          ) : (
            <ul className="vault-entries">
              {view.entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  canManage={can.allowed}
                  error={error}
                  busy={busy}
                  onToggle={() =>
                    void act(() =>
                      api.updateVaultEntry(entry.workspaceId, entry.id, {
                        expectedRevision: entry.revision,
                        enabled: !entry.enabled,
                      }),
                    )
                  }
                  onReplace={(value) =>
                    act(() =>
                      api.replaceVaultValue(entry.workspaceId, entry.id, {
                        expectedRevision: entry.revision,
                        ...value,
                      }),
                    )
                  }
                  onRequests={(requests) =>
                    act(() =>
                      api.setVaultRequests(entry.workspaceId, entry.id, {
                        expectedRevision: entry.revision,
                        requests,
                      }),
                    )
                  }
                  onDelete={() => {
                    if (!window.confirm(t("vault.confirmDelete", { name: entry.name }))) return;
                    void act(() =>
                      api.deleteVaultEntry(entry.workspaceId, entry.id, entry.revision),
                    );
                  }}
                />
              ))}
            </ul>
          )}
          {can.allowed && view.available ? (
            <Dialog open={creating} onOpenChange={setCreating}>
              <DialogContent
                className="vault-dialog max-w-lg overflow-y-auto"
                closeLabel={t("vault.cancel")}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  createTrigger.current?.focus();
                }}
              >
                <DialogTitle>{t("vault.create.title")}</DialogTitle>
                <DialogDescription>{t("vault.sharedNote")}</DialogDescription>
                {error ? (
                  <p role="alert" className="error">
                    {error}
                  </p>
                ) : null}
                <CreateForm
                  busy={busy}
                  onCreate={async (input) => {
                    const created = await act(() => api.createVaultEntry(view.workspaceId, input));
                    if (created) setCreating(false);
                    return created;
                  }}
                />
              </DialogContent>
            </Dialog>
          ) : !can.allowed ? (
            <RoleNote action="vault.manage" does={t("vault.roleNote")} />
          ) : null}
        </>
      )}
    </section>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
}) {
  return (
    <label className="vault-field">
      {label}
      <input
        type="password"
        name={name}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** A browser login's username is secret payload too: typed like a password, never shown back. */
function ValueFields({
  type,
  value,
  onChange,
}: {
  type: VaultEntryType;
  value: { username: string; password: string; token: string };
  onChange: (value: { username: string; password: string; token: string }) => void;
}) {
  const t = useT();
  return type === "browser_login" ? (
    <>
      <SecretInput
        name="vault-username"
        label={t("vault.field.username")}
        value={value.username}
        onChange={(username) => onChange({ ...value, username })}
      />
      <SecretInput
        name="vault-password"
        label={t("vault.field.password")}
        value={value.password}
        onChange={(password) => onChange({ ...value, password })}
      />
    </>
  ) : (
    <SecretInput
      name="vault-token"
      label={t("vault.field.token")}
      value={value.token}
      onChange={(token) => onChange({ ...value, token })}
    />
  );
}

const EMPTY_VALUE = { username: "", password: "", token: "" };

function valueInput(type: VaultEntryType, value: typeof EMPTY_VALUE) {
  return type === "browser_login"
    ? { ...(value.username ? { username: value.username } : {}), password: value.password }
    : { token: value.token };
}

function CreateForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: Parameters<VaultApi["createVaultEntry"]>[1]) => Promise<boolean>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<VaultEntryType>("browser_login");
  const [origin, setOrigin] = useState("");
  const [value, setValue] = useState(EMPTY_VALUE);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = valueInput(type, value);
    // Decision 2: the typed value leaves the form with this request and nowhere else.
    setValue(EMPTY_VALUE);
    const created = await onCreate({
      name,
      ...(purpose ? { purpose } : {}),
      type,
      targetOrigin: origin,
      ...secret,
    });
    if (created) {
      setName("");
      setPurpose("");
      setOrigin("");
    }
  };

  return (
    <form className="vault-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <label className="vault-field">
        {t("vault.field.name")}
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label className="vault-field">
        {t("vault.field.purpose")}
        <input value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      </label>
      <label className="vault-field">
        {t("vault.field.type")}
        <select value={type} onChange={(event) => setType(event.target.value as VaultEntryType)}>
          <option value="browser_login">{t("vault.type.browser_login")}</option>
          <option value="http_header_token">{t("vault.type.http_header_token")}</option>
        </select>
      </label>
      <label className="vault-field">
        {t("vault.field.origin")}
        <input
          value={origin}
          placeholder={ORIGIN_EXAMPLE}
          onChange={(event) => setOrigin(event.target.value)}
          required
        />
      </label>
      <ValueFields type={type} value={value} onChange={setValue} />
      <p className="muted small">{t("vault.create.originNote")}</p>
      <div className="form-actions">
        <Button type="submit" disabled={busy}>
          {t("vault.create.submit")}
        </Button>
      </div>
    </form>
  );
}

function EntryCard({
  entry,
  canManage,
  error,
  busy,
  onToggle,
  onReplace,
  onRequests,
  onDelete,
}: {
  entry: VaultEntry;
  canManage: boolean;
  error: string;
  busy: boolean;
  onToggle: () => void;
  onReplace: (value: ReturnType<typeof valueInput>) => Promise<boolean>;
  onRequests: (requests: VaultRequestDefinition[]) => Promise<boolean>;
  onDelete: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState(EMPTY_VALUE);
  const [editing, setEditing] = useState(false);

  const replace = async (event: FormEvent) => {
    event.preventDefault();
    const secret = valueInput(entry.type, value);
    setValue(EMPTY_VALUE);
    if (await onReplace(secret)) setReplacing(false);
  };

  return (
    <li className="vault-entry">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setValue(EMPTY_VALUE);
            setReplacing(false);
            setEditing(false);
          }
        }}
      >
        <DialogTrigger asChild>
          <button type="button" className="vault-entry-row">
            <span>
              <strong>{entry.name}</strong>
              <span className="muted small">{entry.targetOrigin}</span>
            </span>
            <span className="small">
              {entry.usable
                ? t("vault.state.usable")
                : t(`vault.unusable.${entry.unusableReason ?? "disabled"}`)}
            </span>
          </button>
        </DialogTrigger>
        <DialogContent
          className="vault-dialog max-w-lg overflow-y-auto"
          closeLabel={t("vault.cancel")}
        >
          <DialogTitle>{entry.name}</DialogTitle>
          <DialogDescription>{entry.purpose || entry.targetOrigin}</DialogDescription>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
          <div className="vault-entry-head">
            <span className="muted small">
              {t(`vault.type.${entry.type}`)} · {entry.targetOrigin} ·{" "}
              {t("vault.revision", { revision: entry.revision })}
            </span>
          </div>
          <p className="small">
            {entry.enabled ? t("vault.state.enabled") : t("vault.state.disabled")}
            {" · "}
            {entry.usable
              ? t("vault.state.usable")
              : t(`vault.unusable.${entry.unusableReason ?? "disabled"}`)}
          </p>
          <p className="muted small">
            {entry.lastUse
              ? t("vault.lastUse", {
                  at: formatDateTime(entry.lastUse.at),
                  status: entry.lastUse.status,
                  operation: entry.lastUse.operation,
                })
              : t("vault.neverUsed")}
          </p>
          {entry.type === "http_header_token" ? (
            <RequestList
              entry={entry}
              canManage={canManage}
              editing={editing}
              busy={busy}
              onEdit={() => setEditing(true)}
              onCancel={() => setEditing(false)}
              onSave={async (requests) => {
                const saved = await onRequests(requests);
                if (saved) setEditing(false);
                return saved;
              }}
            />
          ) : null}
          {canManage ? (
            <div className="form-actions">
              <Button type="button" variant="tertiary" disabled={busy} onClick={onToggle}>
                {entry.enabled ? t("vault.disable") : t("vault.enable")}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                disabled={busy || replacing}
                onClick={() => setReplacing(true)}
              >
                {t("vault.replace")}
              </Button>
              <Button type="button" variant="tertiary" disabled={busy} onClick={onDelete}>
                {t("vault.delete")}
              </Button>
            </div>
          ) : null}
          {replacing ? (
            <form
              className="vault-form"
              onSubmit={(event) => void replace(event)}
              autoComplete="off"
            >
              <ValueFields type={entry.type} value={value} onChange={setValue} />
              <p className="muted small">{t("vault.replaceNote")}</p>
              <div className="form-actions">
                <Button type="submit" disabled={busy}>
                  {t("vault.replaceSubmit")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => {
                    setValue(EMPTY_VALUE);
                    setReplacing(false);
                  }}
                >
                  {t("vault.cancel")}
                </Button>
              </div>
            </form>
          ) : null}
          {canManage ? <p className="muted small">{t("vault.deleteNote")}</p> : null}
        </DialogContent>
      </Dialog>
    </li>
  );
}

const BLANK_REQUEST: Omit<VaultRequestDefinition, "id"> = {
  name: "",
  method: "GET",
  path: "/",
  params: [],
  header: { scheme: "bearer" },
  effect: "read",
};

function RequestList({
  entry,
  canManage,
  editing,
  busy,
  onEdit,
  onCancel,
  onSave,
}: {
  entry: VaultEntry;
  canManage: boolean;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (requests: VaultRequestDefinition[]) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(BLANK_REQUEST);
  const [paramsText, setParamsText] = useState("");
  const reset = () => {
    setDraft(BLANK_REQUEST);
    setParamsText("");
  };
  const add = async () => {
    const next = { ...draft, params: parseParams(paramsText) } as VaultRequestDefinition;
    if (await onSave([...entry.requests, next])) reset();
  };
  return (
    <div className="vault-requests">
      <h4>{t("vault.requests.title")}</h4>
      {entry.requests.length === 0 ? (
        <p className="muted small">{t("vault.requests.none")}</p>
      ) : (
        <ul>
          {entry.requests.map((r) => (
            <li key={r.id} className="small">
              <code>
                {r.method} {r.path}
              </code>{" "}
              {r.name} · {t(`vault.effect.${r.effect}`)}
              {canManage ? (
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => void onSave(entry.requests.filter((other) => other.id !== r.id))}
                >
                  {t("vault.requests.remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{t("vault.requests.note")}</p>
      {canManage && !editing ? (
        <Button type="button" variant="tertiary" disabled={busy} onClick={onEdit}>
          {t("vault.requests.add")}
        </Button>
      ) : null}
      {canManage && editing ? (
        <div className="vault-form">
          <label className="vault-field">
            {t("vault.field.name")}
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="vault-field">
            {t("vault.requests.method")}
            <select
              value={draft.method}
              onChange={(e) =>
                setDraft({ ...draft, method: e.target.value as VaultRequestDefinition["method"] })
              }
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="vault-field">
            {t("vault.requests.path")}
            <input
              value={draft.path}
              onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            />
          </label>
          <label className="vault-field">
            {t("vault.requests.params")}
            <textarea value={paramsText} rows={3} onChange={(e) => setParamsText(e.target.value)} />
          </label>
          <label className="vault-field">
            {t("vault.requests.header")}
            <input
              value={draft.header.scheme === "header" ? draft.header.name : ""}
              placeholder={BEARER_EXAMPLE}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  header: e.target.value
                    ? { scheme: "header", name: e.target.value }
                    : { scheme: "bearer" },
                })
              }
            />
          </label>
          <label className="vault-field">
            {t("vault.requests.effect")}
            <select
              value={draft.effect}
              onChange={(e) =>
                setDraft({ ...draft, effect: e.target.value as VaultRequestDefinition["effect"] })
              }
            >
              <option value="read">{t("vault.effect.read")}</option>
              <option value="write">{t("vault.effect.write")}</option>
            </select>
          </label>
          <div className="form-actions">
            <Button
              type="button"
              disabled={busy || draft.name.trim() === ""}
              onClick={() => void add()}
            >
              {t("vault.requests.save")}
            </Button>
            <Button
              type="button"
              variant="tertiary"
              disabled={busy}
              onClick={() => {
                reset();
                onCancel();
              }}
            >
              {t("vault.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
