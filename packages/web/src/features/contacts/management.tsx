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
import { useTuneView } from "../../lib/interface-view.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { RunStatsSection } from "../run-stats/run-stats-section.js";
import { EgressModePicker } from "../workspaces/egress-mode-picker.js";
import { BotApps } from "./bot-apps.js";
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
  const canEdit = useCan("bot.editSoul", bot.workspaceId).allowed;
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
      <RoleNote allowed={canEdit} action="bot.editSoul" does={t("management.soul.roleNote")} />
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
  const canUpdate = useCan("approvalRule.update", bot.workspaceId).allowed;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canCreate = useCan("approvalRule.create", bot.workspaceId).allowed;
  const canDelete = useCan("approvalRule.delete", bot.workspaceId).allowed;
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
      <RoleNote
        allowed={canCreate}
        action="approvalRule.create"
        does={t("management.rules.roleNote")}
      />
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
  const canConfigure = useCan("bot.configure", bot.workspaceId).allowed;
  const t = useT();
  // SOUL, model, approval rules and run statistics are tuning (docs/use-and-tune-views.md).
  const tune = useTuneView();
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
        {tune ? (
          <SoulEditor api={api} bot={bot} />
        ) : (
          <details className="settings-advanced">
            <summary>{t("management.soul.title")}</summary>
            <SoulEditor api={api} bot={bot} />
          </details>
        )}
      </section>
      {tune ? (
        <section className="card settings-section">
          <h3>{t("management.model.title")}</h3>
          <p className="muted small">{t("management.model.intro", { name: bot.name })}</p>
          <RoleNote
            allowed={canConfigure}
            action="bot.configure"
            does={t("management.model.roleNote")}
          />
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
      ) : null}
      <section className="card settings-section">
        <BotSchedules api={api} bot={bot} timeZone={timeZone} onSaved={onSaved} />
      </section>
      <BotApps key={`apps-${bot.id}`} api={api} bot={bot} onSaved={onSaved} />
      {tune ? (
        <>
          <section className="card settings-section">
            <ApprovalRulesEditor api={api} bot={bot} />
          </section>
          <RunStatsSection api={api} bot={bot} />
        </>
      ) : null}
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
