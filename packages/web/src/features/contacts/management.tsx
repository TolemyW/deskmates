import type {
  ApprovalRule,
  ApprovalRuleMatcher,
  BotDefinition,
  OperatorConfig,
  Workspace,
} from "@deskmates/contracts";
import { EGRESS_OPEN_INTERNET, isOpenInternetAllowlist } from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { EgressModePicker } from "../workspaces/egress-mode-picker.js";
import { BotIdentity } from "./bot-identity.js";
import { BotSchedules } from "./bot-schedules.js";
import { VisionCapability } from "./model-capability.js";
import { ModelPicker, ModelSuggestions, registeredModelLabel } from "./model-picker.js";
import { RuleVersions } from "./rule-versions.js";
import { SoulProposalPanel } from "./soul-proposal.js";

interface SoulDraft {
  body: string;
  savedBody: string;
  version: string;
}

// One cache per authenticated client: drafts survive in-app navigation and disappear on
// disconnect, credential expiry or reload with the client that owned them.
const soulDrafts = new WeakMap<ApiClient, Map<BotDefinition["id"], SoulDraft>>();

function soulDraftMap(api: ApiClient): Map<BotDefinition["id"], SoulDraft> {
  let drafts = soulDrafts.get(api);
  if (!drafts) {
    drafts = new Map();
    soulDrafts.set(api, drafts);
  }
  return drafts;
}

// Examples in input placeholders: identifiers, the same in every language.
const TOOL_NAME_EXAMPLE = "mcp__browser__browser_click";
const TARGET_ORIGIN_EXAMPLE = "https://ops.example.test";
const FILE_PATH_EXAMPLE = "/work/exports";
const DOMAINS_EXAMPLE = "example.com, api.example.com";

function domains(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function TrashSection({
  api,
  onWorkspaceRestored,
  onBotRestored,
}: {
  api: ApiClient;
  onWorkspaceRestored: (workspace: Workspace) => void;
  onBotRestored: (bot: BotDefinition) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [typedNames, setTypedNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canView = useCan("trash.view").allowed;
  const t = useT();

  const refresh = useCallback(
    () =>
      api
        .listTrash()
        .then((trash) => {
          setWorkspaces(trash?.workspaces?.filter((workspace) => workspace.archivedAt) ?? []);
          setBots(trash?.bots?.filter((bot) => bot.archivedAt) ?? []);
        })
        .catch((err: unknown) => setError(errorMessage(err))),
    [api],
  );

  useEffect(() => {
    if (canView) refresh();
  }, [canView, refresh]);

  if (!canView) return null;
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="management-section">
      <h2>{t("management.trash.title")}</h2>
      <p>{t("management.trash.intro")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {workspaces.length === 0 && bots.length === 0 ? (
        <p className="muted">{t("management.trash.empty")}</p>
      ) : null}
      <div className="management-grid">
        {workspaces.map((workspace) => (
          <article className="management-card" key={workspace.id}>
            <h3>{workspace.name}</h3>
            <p>{t("management.trash.workspace")}</p>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => onWorkspaceRestored(await api.restoreWorkspace(workspace.id)))
              }
            >
              {t("management.trash.restore")}
            </Button>
            <label>
              {t("management.trash.typeName", { name: workspace.name })}
              <input
                value={typedNames[workspace.id] ?? ""}
                onChange={(event) =>
                  setTypedNames((current) => ({ ...current, [workspace.id]: event.target.value }))
                }
              />
            </label>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || typedNames[workspace.id] !== workspace.name}
              onClick={() =>
                void act(() => api.permanentlyDeleteWorkspace(workspace.id, workspace.name))
              }
            >
              {t("management.trash.delete")}
            </Button>
          </article>
        ))}
        {bots.map((bot) => (
          <article className="management-card" key={bot.id}>
            <h3>{bot.name}</h3>
            <p>{t("management.trash.bot")}</p>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void act(async () => onBotRestored(await api.restoreBot(bot.id)))}
            >
              {t("management.trash.restore")}
            </Button>
            <label>
              {t("management.trash.typeName", { name: bot.name })}
              <input
                value={typedNames[bot.id] ?? ""}
                onChange={(event) =>
                  setTypedNames((current) => ({ ...current, [bot.id]: event.target.value }))
                }
              />
            </label>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || typedNames[bot.id] !== bot.name}
              onClick={() => void act(() => api.permanentlyDeleteBot(bot.id, bot.name))}
            >
              {t("management.trash.delete")}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * A workspace whose allowlist is the lone `*` browses any public site (ADR-0010). It is an
 * untrusted-browsing workspace, so it is labelled where its egress is shown and edited.
 */
function OpenInternetBadge() {
  const t = useT();
  return (
    <span
      className="ml-2 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 align-middle text-xs font-semibold text-amber-900"
      title={t("management.openInternet.title")}
    >
      {t("management.openInternet.label")}
    </span>
  );
}

export function EgressEditor({
  api,
  workspace,
  onSaved,
}: {
  api: ApiClient;
  workspace: Workspace;
  onSaved: (workspace: Workspace) => void;
}) {
  const open = isOpenInternetAllowlist(workspace.egressAllowlist);
  const [locked, setLocked] = useState(!open);
  const [draft, setDraft] = useState(open ? "" : workspace.egressAllowlist.join("\n"));
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canConfigure = useCan("workspace.configure").allowed;
  const t = useT();
  const next = useMemo(
    () =>
      locked ? domains(draft).filter((d) => d !== EGRESS_OPEN_INTERNET) : [EGRESS_OPEN_INTERNET],
    [draft, locked],
  );
  const removed = workspace.egressAllowlist.filter((item) => !next.includes(item));

  const save = async () => {
    if (removed.length > 0 && !confirmingRemoval) {
      setConfirmingRemoval(true);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.updateWorkspaceEgress(workspace.id, next);
      onSaved(saved);
      const nowOpen = isOpenInternetAllowlist(saved.egressAllowlist);
      setLocked(!nowOpen);
      setDraft(nowOpen ? "" : saved.egressAllowlist.join("\n"));
      setConfirmingRemoval(false);
      setNotice(t("management.egress.saved"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="management-card">
      <h3>
        {workspace.name}
        {isOpenInternetAllowlist(workspace.egressAllowlist) ? <OpenInternetBadge /> : null}
      </h3>
      {workspace.restorationRequirements?.length ? (
        <aside>
          <h4>{t("management.restoration.title")}</h4>
          <p>{t("management.restoration.body")}</p>
          <ul>
            {workspace.restorationRequirements.map((requirement) => (
              <li key={`${requirement.sourceProviderRef}:${requirement.path}`}>
                {t(`management.restoration.${requirement.status}`)}: <code>{requirement.path}</code>{" "}
                ({requirement.sourceProviderRef})
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      <EgressModePicker
        locked={locked}
        domains={draft}
        disabled={busy || !canConfigure}
        onLocked={(value) => {
          setLocked(value);
          setConfirmingRemoval(false);
        }}
        onDomains={(value) => {
          setDraft(value);
          setConfirmingRemoval(false);
        }}
      />
      {confirmingRemoval ? (
        <div className="management-confirm" role="alert">
          <p>{t("management.egress.confirmRemoval", { domains: removed.join(", ") })}</p>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {t("management.egress.confirmRemovalButton")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setConfirmingRemoval(false)}>
            {t("management.cancel")}
          </Button>
        </div>
      ) : (
        <Button type="button" disabled={busy || !canConfigure} onClick={() => void save()}>
          {t("management.egress.save")}
        </Button>
      )}
      <RoleNote action="workspace.configure" does={t("management.egress.roleNote")} />
    </article>
  );
}

function SoulEditor({ api, bot }: { api: ApiClient; bot: BotDefinition }) {
  const initialDraft = soulDraftMap(api).get(bot.id);
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [savedBody, setSavedBody] = useState(initialDraft?.savedBody ?? "");
  const [version, setVersion] = useState(initialDraft?.version ?? "");
  const [latest, setLatest] = useState<{ body: string; version: string }>();
  const [loaded, setLoaded] = useState(initialDraft !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canEdit = useCan("bot.editSoul").allowed;
  const t = useT();

  useEffect(() => {
    let active = true;
    const retained = soulDraftMap(api).get(bot.id);
    api
      .getSoul(bot.id)
      .then((soul) => {
        if (!active) return;
        if (retained && retained.body !== retained.savedBody) {
          setBody(retained.body);
          setSavedBody(retained.savedBody);
          setVersion(retained.version);
          if (retained.version !== soul.version) {
            setLatest(soul);
            setError(currentI18n().t("management.soul.changed"));
          }
        } else {
          soulDraftMap(api).delete(bot.id);
          setBody(soul.body);
          setSavedBody(soul.body);
          setVersion(soul.version);
        }
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api, bot.id]);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.writeSoul(bot.id, body, version);
      setBody(saved.body);
      setSavedBody(saved.body);
      setVersion(saved.version);
      setLatest(undefined);
      soulDraftMap(api).delete(bot.id);
      // ADR-0043 decision 3: a live or parked run keeps what it started with.
      setNotice(
        saved.appliesFromNextRun ? t("management.soul.savedNextRun") : t("management.soul.saved"),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          const current = await api.getSoul(bot.id);
          if (current.version !== version) {
            setLatest(current);
            setError(t("management.soul.changed"));
          } else {
            setLatest(undefined);
            setError(errorMessage(err));
          }
        } catch (refreshError) {
          setError(errorMessage(refreshError));
        }
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!loaded && !error) return <p>{t("management.soul.loading")}</p>;
  return (
    <section className="management-subsection">
      <h3>{t("management.soul.title")}</h3>
      <p className="muted small">{t("management.soul.intro", { name: bot.name })}</p>
      {loaded ? (
        <p className="muted small settings-status">
          {savedBody.trim()
            ? t("management.soul.statusSaved")
            : t("management.soul.statusNeedsInstructions")}
          {body !== savedBody ? ` · ${t("management.soul.unsavedDraft")}` : ""}
          {version ? ` · ${t("management.soul.version", { version: version.slice(0, 8) })}` : ""}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      <textarea
        aria-label={t("management.soul.textareaLabel", { name: bot.name })}
        value={body}
        disabled={!loaded || busy}
        readOnly={!canEdit}
        rows={10}
        onChange={(event) => {
          const next = event.target.value;
          setBody(next);
          soulDraftMap(api).set(bot.id, { body: next, savedBody, version });
          setNotice("");
        }}
      />
      <Button
        type="button"
        disabled={!loaded || busy || body === savedBody || !canEdit}
        onClick={() => void save()}
      >
        {t("management.soul.save")}
      </Button>
      <RoleNote action="bot.editSoul" does={t("management.soul.roleNote")} />
      {canEdit && loaded ? (
        <SoulProposalPanel
          api={api}
          bot={bot}
          loadedVersion={version}
          disabled={body !== savedBody}
          onApplied={(soul) => {
            setBody(soul.body);
            setSavedBody(soul.body);
            setVersion(soul.version);
            setLatest(undefined);
            soulDraftMap(api).delete(bot.id);
          }}
        />
      ) : null}
      {loaded ? (
        <RuleVersions
          api={api}
          bot={bot}
          file="soul"
          currentVersion={version}
          refreshKey={version}
          disabled={body !== savedBody}
          onRestored={(restored) => {
            setBody(restored.body);
            setSavedBody(restored.body);
            setVersion(restored.version);
            setLatest(undefined);
            setError("");
            soulDraftMap(api).delete(bot.id);
          }}
        />
      ) : null}
      {latest ? (
        <div className="management-conflict">
          <p>{t("management.soul.latest")}</p>
          <pre>{latest.body}</pre>
          <Button
            type="button"
            onClick={() => {
              setVersion(latest.version);
              setSavedBody(latest.body);
              soulDraftMap(api).set(bot.id, {
                body,
                savedBody: latest.body,
                version: latest.version,
              });
              setLatest(undefined);
              setError("");
            }}
          >
            {t("management.soul.keepDraft")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setBody(latest.body);
              setSavedBody(latest.body);
              setVersion(latest.version);
              setLatest(undefined);
              setError("");
              soulDraftMap(api).delete(bot.id);
            }}
          >
            {t("management.soul.discardDraft")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const MATCHER_WORDS: Readonly<Record<string, MessageKey>> = {
  toolName: "management.rules.matcher.toolName",
  targetOrigin: "management.rules.matcher.targetOrigin",
  argumentPattern: "management.rules.matcher.argumentPattern",
  filePath: "management.rules.matcher.filePath",
};

function matcherSummary(matcher: ApprovalRuleMatcher): string {
  const { t } = currentI18n();
  const values = Object.entries(matcher).map(([key, value]) => {
    const word = MATCHER_WORDS[key];
    return `${word ? t(word) : key} ${String(value)}`;
  });
  return values.length ? values.join(" · ") : t("management.rules.matcherAll");
}

/**
 * Edit one rule in place (ADR-0043 decision 6): same id and place in the oldest-first order, so
 * only what it says changes. The fields a hand-made rule has; any other matcher key is kept.
 */
function ApprovalRuleEditForm({
  api,
  rule,
  onDone,
}: {
  api: ApiClient;
  rule: ApprovalRule;
  onDone: (saved?: ApprovalRule) => void;
}) {
  const [decision, setDecision] = useState<"allow_always" | "deny">(rule.decision);
  const [toolName, setToolName] = useState(rule.matcher.toolName ?? "");
  const [targetOrigin, setTargetOrigin] = useState(rule.matcher.targetOrigin ?? "");
  const [argumentPattern, setArgumentPattern] = useState(rule.matcher.argumentPattern ?? "");
  const [filePath, setFilePath] = useState(rule.matcher.filePath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = useT();
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const {
        toolName: _tool,
        targetOrigin: _origin,
        argumentPattern: _pattern,
        filePath: _path,
        ...kept
      } = rule.matcher;
      const matcher: ApprovalRuleMatcher = {
        ...kept,
        ...(toolName.trim() ? { toolName: toolName.trim() } : {}),
        ...(targetOrigin.trim() ? { targetOrigin: targetOrigin.trim() } : {}),
        ...(argumentPattern.trim() ? { argumentPattern: argumentPattern.trim() } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
      };
      onDone(await api.updateApprovalRule(rule.id, { decision, matcher }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="rule-edit" disabled={busy}>
      {error ? <p role="alert">{error}</p> : null}
      <Select
        label={t("management.rules.decision")}
        value={decision}
        onValueChange={(value) => setDecision(value as typeof decision)}
        disabled={busy}
        options={[
          { value: "allow_always", label: t("management.rules.alwaysAllow") },
          { value: "deny", label: t("management.rules.deny") },
        ]}
      />
      <label>
        {t("management.rules.toolName")}
        <input value={toolName} onChange={(event) => setToolName(event.target.value)} />
      </label>
      <label>
        {t("management.rules.targetOrigin")}
        <input value={targetOrigin} onChange={(event) => setTargetOrigin(event.target.value)} />
      </label>
      <label>
        {t("management.rules.argumentPattern")}
        <input
          value={argumentPattern}
          onChange={(event) => setArgumentPattern(event.target.value)}
        />
      </label>
      <label>
        {t("management.rules.filePath")}
        <input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
      </label>
      <Button type="button" onClick={() => void save()}>
        {t("management.rules.saveEdit")}
      </Button>
      <Button type="button" onClick={() => onDone()}>
        {t("management.cancel")}
      </Button>
    </fieldset>
  );
}

/** Approval rules per page (#113 slice B, plan row 31). */
export const RULE_PAGE_SIZE = 25;

function ApprovalRulesEditor({ api, bot }: { api: ApiClient; bot: BotDefinition }) {
  // One numbered page of the bot's rules with the honest total; a delete that empties the last
  // page steps back (usePagedQuery).
  const pages = usePagedQuery<ApprovalRule>({
    scopeKey: `contacts.rules:${bot.id}`,
    limit: RULE_PAGE_SIZE,
    mode: "offset",
    fetchPage: async ({ offset, limit }) => {
      const page = await api.listApprovalRules(bot.id, { offset, limit });
      return { items: page.rules, total: page.total };
    },
  });
  const rules = pages.items;
  const reloadRules = pages.reload;
  const [toolName, setToolName] = useState("");
  const [targetOrigin, setTargetOrigin] = useState("");
  const [argumentPattern, setArgumentPattern] = useState("");
  const [filePath, setFilePath] = useState("");
  const [decision, setDecision] = useState<"allow_always" | "deny">("allow_always");
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const canUpdate = useCan("approvalRule.update").allowed;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canCreate = useCan("approvalRule.create").allowed;
  const canDelete = useCan("approvalRule.delete").allowed;
  const t = useT();

  const loadError = pages.error ? errorMessage(pages.error) : "";

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const matcher: ApprovalRuleMatcher = {
        toolName: toolName.trim(),
        ...(targetOrigin.trim() ? { targetOrigin: targetOrigin.trim() } : {}),
        ...(argumentPattern.trim() ? { argumentPattern: argumentPattern.trim() } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
      };
      await api.createApprovalRule(bot.id, matcher, decision);
      reloadRules();
      setToolName("");
      setTargetOrigin("");
      setArgumentPattern("");
      setFilePath("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api.deleteApprovalRule(id);
      reloadRules();
      setConfirmDelete(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="management-subsection">
      <h3>{t("management.rules.title")}</h3>
      <p className="muted small">
        {t.rich("management.rules.intro", {
          name: bot.name,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {rules.length === 0 ? <p className="muted small">{t("management.rules.empty")}</p> : null}
      <ul aria-label={t("management.rules.listLabel", { name: bot.name })} className="rule-list">
        {rules.map((rule) => (
          <li key={rule.id}>
            <span className={`pill ${rule.decision === "allow_always" ? "success" : "danger"}`}>
              {rule.decision === "allow_always"
                ? t("management.rules.alwaysAllow")
                : t("management.rules.deny")}
            </span>{" "}
            {matcherSummary(rule.matcher)}
            {editing === rule.id ? (
              <ApprovalRuleEditForm
                api={api}
                rule={rule}
                onDone={(saved) => {
                  setEditing(undefined);
                  if (saved) reloadRules();
                }}
              />
            ) : canUpdate ? (
              <Button type="button" disabled={busy} onClick={() => setEditing(rule.id)}>
                {t("management.rules.edit")}
              </Button>
            ) : null}
            {confirmDelete === rule.id ? (
              <span className="management-confirm">
                {t("management.rules.confirmRemove")}
                <Button type="button" disabled={busy} onClick={() => void remove(rule.id)}>
                  {t("management.rules.confirmRemoveButton")}
                </Button>
                <Button type="button" disabled={busy} onClick={() => setConfirmDelete(undefined)}>
                  {t("management.cancel")}
                </Button>
              </span>
            ) : canDelete ? (
              <Button type="button" disabled={busy} onClick={() => setConfirmDelete(rule.id)}>
                {t("management.rules.remove")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <PageBar query={pages} label={t("management.rules.pages")} />
      {loadError ? <p className="error small">{loadError}</p> : null}
      <RoleNote action="approvalRule.create" does={t("management.rules.roleNote")} />
      {canCreate ? (
        <details className="settings-advanced">
          <summary>{t("management.rules.byHand")}</summary>
          <p className="muted small">{t("management.rules.byHandIntro")}</p>
          <fieldset disabled={busy}>
            <Select
              label={t("management.rules.decision")}
              value={decision}
              onValueChange={(value) => setDecision(value as typeof decision)}
              disabled={busy}
              options={[
                {
                  value: "allow_always",
                  label: t("management.rules.alwaysAllow"),
                },
                {
                  value: "deny",
                  label: t("management.rules.deny"),
                },
              ]}
            />

            <label>
              {t("management.rules.toolName")}
              <input
                required
                value={toolName}
                placeholder={TOOL_NAME_EXAMPLE}
                onChange={(event) => setToolName(event.target.value)}
              />
            </label>
            <label>
              {t("management.rules.targetOrigin")}
              <input
                value={targetOrigin}
                placeholder={t("management.rules.optionalExample", {
                  example: TARGET_ORIGIN_EXAMPLE,
                })}
                onChange={(event) => setTargetOrigin(event.target.value)}
              />
            </label>
            <label>
              {t("management.rules.argumentPattern")}
              <input
                value={argumentPattern}
                placeholder={t("management.rules.argumentPatternPlaceholder")}
                onChange={(event) => setArgumentPattern(event.target.value)}
              />
            </label>
            <label>
              {t("management.rules.filePath")}
              <input
                value={filePath}
                placeholder={t("management.rules.optionalExample", { example: FILE_PATH_EXAMPLE })}
                onChange={(event) => setFilePath(event.target.value)}
              />
            </label>
            <Button type="button" disabled={!toolName.trim()} onClick={() => void create()}>
              {t("management.rules.add")}
            </Button>
          </fieldset>
        </details>
      ) : null}
    </section>
  );
}

export function BotEditor({
  api,
  bot,
  config,
  timeZone,
  workspaceName,
  onSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  config: OperatorConfig;
  timeZone: string;
  workspaceName: string;
  onSaved: (bot: BotDefinition) => void;
}) {
  const [model, setModel] = useState(bot.model ?? "");
  const [cheapModel, setCheapModel] = useState(bot.cheapModel ?? "");
  // Remounts the pickers after a save so their choice follows the saved override.
  const [saves, setSaves] = useState(0);
  const models = config.models ?? [];
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [openingChat, setOpeningChat] = useState(false);
  const canConfigure = useCan("bot.configure").allowed;
  const t = useT();
  const openTestChat = async () => {
    setOpeningChat(true);
    setError("");
    try {
      const { thread } = await api.createThread({
        workspaceId: bot.workspaceId,
        botIds: [bot.id],
        title: t("management.tryIt.threadTitle", { name: bot.name }),
      });
      window.location.hash = `#/threads/${encodeURIComponent(thread.id)}`;
    } catch (err) {
      setError(errorMessage(err));
      setOpeningChat(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.updateBot(bot.id, {
        model: model.trim() || null,
        cheapModel: cheapModel.trim() || null,
      });
      setModel(saved.model ?? "");
      setCheapModel(saved.cheapModel ?? "");
      setSaves((n) => n + 1);
      onSaved(saved);
      setNotice(t("management.model.saved"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="management-card bot-settings">
      <h3 className="sr-only">{bot.name}</h3>
      <p className="sr-only">{workspaceName}</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      <section className="card settings-section">
        <BotIdentity key={bot.id} api={api} bot={bot} onSaved={onSaved} />
      </section>
      <section className="card settings-section">
        <SoulEditor api={api} bot={bot} />
      </section>
      <section className="card settings-section">
        <h3>{t("management.model.title")}</h3>
        <p className="muted small">{t("management.model.intro", { name: bot.name })}</p>
        <RoleNote action="bot.configure" does={t("management.model.roleNote")} />
        <fieldset disabled={busy || !canConfigure}>
          <ModelPicker
            key={`model-${saves}`}
            label={t("management.model.label")}
            overrideLabel={t("management.model.override")}
            value={model}
            onChange={setModel}
            deploymentModel={config.defaultModel}
            models={models}
            disabled={busy || !canConfigure}
          />
          <details className="settings-advanced">
            <summary>{t("management.model.cheapSummary")}</summary>
            <p className="muted small">{t("management.model.cheapIntro")}</p>
            <ModelPicker
              key={`cheap-${saves}`}
              label={t("management.model.cheapLabel")}
              overrideLabel={t("management.model.cheapOverride")}
              value={cheapModel}
              onChange={setCheapModel}
              deploymentModel={config.cheapModel}
              models={models}
              disabled={busy || !canConfigure}
            />
          </details>
          <div className="settings-actions">
            <Button type="button" variant="default" onClick={() => void save()}>
              {t("management.model.save")}
            </Button>
            <span className="management-effective-model">
              {t.rich("management.model.effective", {
                model: registeredModelLabel(t, models, bot.model || config.defaultModel),
                code: (chunks) => <code>{chunks}</code>,
              })}
            </span>
            <span className="management-effective-model">
              {t.rich("management.model.effectiveCheap", {
                model: registeredModelLabel(t, models, bot.cheapModel || config.cheapModel),
                code: (chunks) => <code>{chunks}</code>,
              })}
            </span>
          </div>
          <VisionCapability
            api={api}
            workspaceId={bot.workspaceId}
            model={bot.model || config.defaultModel}
          />
        </fieldset>
      </section>
      <section className="card settings-section">
        <BotSchedules api={api} bot={bot} timeZone={timeZone} onSaved={onSaved} />
      </section>
      <section className="card settings-section">
        <ApprovalRulesEditor api={api} bot={bot} />
      </section>
      <section className="card settings-section">
        <h3>{t("management.tryIt.title")}</h3>
        <p className="muted small">{t("management.tryIt.intro", { name: bot.name })}</p>
        <Button type="button" disabled={openingChat} onClick={() => void openTestChat()}>
          {t("management.tryIt.start")}
        </Button>
      </section>
    </article>
  );
}

export function ManagementScreen({
  api,
  embedded = false,
}: { api: ApiClient; embedded?: boolean }) {
  const [config, setConfig] = useState<OperatorConfig>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [botSearch, setBotSearch] = useState("");
  const [selectedBotId, setSelectedBotId] = useState<BotDefinition["id"]>();
  const [workspaceName, setWorkspaceName] = useState("");
  const [egress, setEgress] = useState("");
  const [botName, setBotName] = useState("");
  const [role, setRole] = useState("");
  const [workspaceId, setWorkspaceId] = useState<Workspace["id"] | "">("");
  const [model, setModel] = useState("");
  const [cheapModel, setCheapModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canCreateWorkspace = useCan("workspace.create").allowed;
  const canCreateBot = useCan("bot.create").allowed;
  const canArchiveWorkspace = useCan("workspace.archive").allowed;
  const canArchiveBot = useCan("bot.archive").allowed;
  const t = useT();

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.listWorkspaces(), api.listBots()])
      .then(([nextConfig, nextWorkspaces, nextBots]) => {
        if (!active) return;
        setConfig(nextConfig);
        setWorkspaces(nextWorkspaces);
        setBots(nextBots);
        setSelectedBotId((current) => current ?? nextBots[0]?.id);
        setWorkspaceId((current) => current || nextWorkspaces[0]?.id || "");
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedBot = bots.find((bot) => bot.id === selectedBotId);
  const visibleBots = bots.filter((bot) => {
    const workspace = workspaces.find((item) => item.id === bot.workspaceId)?.name ?? "";
    return `${bot.name} ${bot.role} ${workspace}`
      .toLocaleLowerCase()
      .includes(botSearch.toLocaleLowerCase());
  });

  return (
    <section className={embedded ? "management-screen embedded" : "management-screen"}>
      <header>
        {embedded ? null : <h1>{t("management.screen.title")}</h1>}
        {config ? (
          <p>
            {t.rich("management.screen.defaults", {
              defaultModel: config.defaultModel,
              cheapModel: config.cheapModel,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        ) : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}

      <section className="management-section">
        <h2>{t("management.workspace.createTitle")}</h2>
        <RoleNote action="workspace.create" does={t("management.workspace.roleNote")} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const created = await api.createWorkspace({
                name: workspaceName.trim(),
                egressAllowlist: domains(egress),
              });
              setWorkspaces((items) => [...items, created]);
              setWorkspaceId(created.id);
              setWorkspaceName("");
              setEgress("");
              setNotice(t("management.workspace.created"));
            });
          }}
        >
          <fieldset disabled={busy || !canCreateWorkspace}>
            <label>
              {t("management.workspace.name")}
              <input
                required
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </label>
            <label>
              {t("management.workspace.allowedDomains")}
              <textarea
                value={egress}
                placeholder={DOMAINS_EXAMPLE}
                onChange={(event) => setEgress(event.target.value)}
              />
            </label>
            <Button type="submit">{t("management.workspace.create")}</Button>
          </fieldset>
        </form>
      </section>

      <section className="management-section">
        <h2>{t("management.egress.title")}</h2>
        <div className="management-grid">
          {workspaces.map((workspace) => (
            <div key={workspace.id}>
              <EgressEditor
                api={api}
                workspace={workspace}
                onSaved={(saved) =>
                  setWorkspaces((items) =>
                    items.map((item) => (item.id === saved.id ? saved : item)),
                  )
                }
              />
              {canArchiveWorkspace ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api.archiveWorkspace(workspace.id);
                      setWorkspaces((items) => items.filter((item) => item.id !== workspace.id));
                      setBots((items) => items.filter((item) => item.workspaceId !== workspace.id));
                    })
                  }
                >
                  {t("management.trash.archiveWorkspace")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="management-section">
        <h2>{t("management.bot.createTitle")}</h2>
        <RoleNote action="bot.create" does={t("management.bot.roleNote")} />
        {workspaces.length === 0 ? (
          <p>{t("management.bot.needWorkspace")}</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                if (!workspaceId) return;
                const created = await api.createBot({
                  name: botName.trim(),
                  workspaceId,
                  ...(role.trim() ? { role: role.trim() } : {}),
                  ...(model.trim() ? { model: model.trim() } : {}),
                  ...(cheapModel.trim() ? { cheapModel: cheapModel.trim() } : {}),
                });
                setBots((items) => [...items, created]);
                setSelectedBotId(created.id);
                setBotName("");
                setRole("");
                setModel("");
                setCheapModel("");
                setNotice(t("management.bot.created"));
              });
            }}
          >
            <fieldset disabled={busy || !canCreateBot}>
              <Select
                label={t("management.bot.workspace")}
                required
                value={workspaceId}
                onValueChange={(value) => setWorkspaceId(value as Workspace["id"])}
                disabled={busy || !canCreateBot}
                options={[
                  ...workspaces.map((workspace) => ({
                    value: workspace.id,
                    label: workspace.name,
                  })),
                ]}
              />

              <label>
                {t("management.bot.name")}
                <input
                  required
                  value={botName}
                  onChange={(event) => setBotName(event.target.value)}
                />
              </label>
              <label>
                {t("management.bot.role")}
                <input value={role} onChange={(event) => setRole(event.target.value)} />
              </label>
              <p>{t("management.bot.roleHelp")}</p>
              <label>
                {t("management.bot.modelOverride")}
                <input
                  value={model}
                  list="management-registered-models"
                  placeholder={config?.defaultModel}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <label>
                {t("management.bot.cheapModelOverride")}
                <input
                  value={cheapModel}
                  list="management-registered-models"
                  placeholder={config?.cheapModel}
                  onChange={(event) => setCheapModel(event.target.value)}
                />
              </label>
              <ModelSuggestions id="management-registered-models" models={config?.models ?? []} />
              <Button type="submit">{t("management.bot.create")}</Button>
            </fieldset>
          </form>
        )}
      </section>

      <section className="management-section">
        <h2>{t("management.bots.title")}</h2>
        <label>
          {t("management.bots.find")}
          <input
            value={botSearch}
            onChange={(event) => setBotSearch(event.target.value)}
            placeholder={t("management.bots.findPlaceholder")}
          />
        </label>
        <div className="management-bot-layout">
          <div aria-label={t("management.bots.roster")} className="management-bot-roster">
            {visibleBots.map((bot) => (
              <div key={bot.id}>
                <Button
                  type="button"
                  aria-pressed={selectedBotId === bot.id}
                  onClick={() => setSelectedBotId(bot.id)}
                >
                  {bot.name} · {bot.role || t("management.bots.noRole")}
                </Button>
                {canArchiveBot ? (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api.archiveBot(bot.id);
                        setBots((items) => items.filter((item) => item.id !== bot.id));
                        if (selectedBotId === bot.id) setSelectedBotId(undefined);
                      })
                    }
                  >
                    {t("management.trash.archiveBot")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {config && selectedBot ? (
            <BotEditor
              key={selectedBot.id}
              api={api}
              bot={selectedBot}
              config={config}
              timeZone={config.cronTimeZone}
              workspaceName={
                workspaces.find((workspace) => workspace.id === selectedBot.workspaceId)?.name ??
                t("management.bots.unknownWorkspace")
              }
              onSaved={(saved) =>
                setBots((items) => items.map((item) => (item.id === saved.id ? saved : item)))
              }
            />
          ) : null}
        </div>
      </section>
      <TrashSection
        api={api}
        onWorkspaceRestored={(workspace) => setWorkspaces((items) => [...items, workspace])}
        onBotRestored={(bot) => setBots((items) => [...items, bot])}
      />
    </section>
  );
}
