// Resources › Skills (issue #27; ADR-0015 consequences): what each bot of the selected workspace
// is given as a skill, what waits in "needs your confirmation" with the scan's findings, and the
// human actions: install by hash, confirm or reject, assign, move a stage, pin, undo. Rows carry
// name, description, stage, enabled bots and last use; origin, hash, scan findings and history
// are in the detail panel; the install form opens on demand for Admins. Members can read
// the records; both the UI and Gateway restrict changes to Admins. No skill semantics change:
// provisional skills stay with their author, and spreading one is a human assignment.

import {
  type BotDefinition,
  SKILL_STAGES,
  type Skill,
  type SkillFile,
  type SkillFindingKind,
  type SkillHoldReason,
  type SkillOrigin,
  type SkillReview,
  type SkillStage,
  type SkillVersion,
  type SkillVersionOp,
  type StarterSkill,
  type WorkspaceId,
  parseSkillFrontmatter,
  skillHashInput,
} from "@deskmates/contracts";
import { ActionMenu, Select } from "@deskmates/ui";
import { Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiClient, SkillsView } from "../../api/client.js";
import { NoWorkspace, ResourceHeading } from "../../components/resource-page.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { useRememberBots } from "../../state/bot-avatars.js";
import { useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import type { PendingSkillVersion } from "./api.js";

/** Skills, the confirmation queue and versions: 25 a page (#113). */
export const SKILLS_PAGE_SIZE = 25;
/** How long the search box waits after the last keystroke before asking the Gateway. */
export const SKILLS_SEARCH_DELAY_MS = 250;

export type SkillsApi = Pick<
  ApiClient,
  | "listSkills"
  | "listPendingSkillVersions"
  | "listSkillVersions"
  | "installSkill"
  | "confirmSkillVersion"
  | "rejectSkillVersion"
  | "assignSkill"
  | "updateSkill"
  | "undoSkill"
>;

const HOLD_TEXT: Readonly<Record<SkillHoldReason, MessageKey>> = {
  scan_findings: "skills.hold.scanFindings",
  no_closed_episode: "skills.hold.noClosedEpisode",
  untrusted_source: "skills.hold.untrustedSource",
  episode_not_succeeded: "skills.hold.episodeNotSucceeded",
  too_few_tool_calls: "skills.hold.tooFewToolCalls",
  duty_change: "skills.hold.dutyChange",
  do_not_learn: "skills.hold.doNotLearn",
  starter_name_reserved: "skills.hold.starterNameReserved",
  revises_installed_skill: "skills.hold.revisesInstalledSkill",
  revises_unused_skill: "skills.hold.revisesUnusedSkill",
};

/** Stages, origins, version operations and scan findings as the page shows them. */
const STAGE_TEXT: Readonly<Record<SkillStage, MessageKey>> = {
  provisional: "skills.stage.provisional",
  active: "skills.stage.active",
  stale: "skills.stage.stale",
  archived: "skills.stage.archived",
};
const ORIGIN_TEXT: Readonly<Record<SkillOrigin, MessageKey>> = {
  installed: "skills.origin.installed",
  authored: "skills.origin.authored",
};
const OP_TEXT: Readonly<Record<SkillVersionOp, MessageKey>> = {
  author: "skills.op.author",
  revise: "skills.op.revise",
  install: "skills.op.install",
  undo: "skills.op.undo",
};
const FINDING_TEXT: Readonly<Record<SkillFindingKind, MessageKey>> = {
  off_allowlist_url: "skills.finding.offAllowlistUrl",
  credential: "skills.finding.credential",
  rule_instruction: "skills.finding.ruleInstruction",
  executable_file: "skills.finding.executableFile",
};
const REVIEW_TEXT: Readonly<Record<SkillReview, MessageKey>> = {
  pending: "skillsPage.review.pending",
  cleared: "skillsPage.review.cleared",
  rejected: "skillsPage.review.rejected",
};

/** A known code's words, else the code itself (a newer Gateway may send one this UI lacks). */
function wordsFor<K extends string>(
  t: (key: MessageKey) => string,
  table: Readonly<Record<K, MessageKey>>,
  code: K,
  fallback: string = code,
): string {
  const key = table[code] as MessageKey | undefined;
  return key ? t(key) : fallback;
}

/** Hex SHA-256 of a skill's content, the same canonical input the Gateway hashes. */
export async function skillSha256(files: readonly SkillFile[]): Promise<string> {
  const bytes = new TextEncoder().encode(skillHashInput(files));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function short(sha: string | undefined, none: string): string {
  return sha ? sha.slice(0, 12) : none;
}

/** The Skills page for the workspace selected in the sidebar. */
export function SkillsScreen({ api }: { api: ApiClient }) {
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const rememberBots = useRememberBots();
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);
  useEffect(() => {
    let active = true;
    api
      .listBots()
      .then((list) => {
        if (!active) return;
        setBots(list);
        rememberBots(list);
      })
      .catch(() => {
        // Without bots the page still lists skills; names fall back to ids.
      });
    return () => {
      active = false;
    };
  }, [api, rememberBots]);

  if (scope.loaded && !workspace) return <NoWorkspace scope={scope} />;
  if (!workspace)
    return <section className="workspace-screen resource-page page-container" aria-busy="true" />;
  return (
    <SkillsPanel
      // A workspace switch starts a fresh page: no row, form, selection or late answer of the
      // previous workspace is shown in the next one.
      key={workspace.id}
      api={api}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      bots={bots.filter((bot) => bot.workspaceId === workspace.id)}
    />
  );
}

export function SkillsPanel({
  api,
  workspaceId,
  workspaceName,
  bots,
}: {
  api: SkillsApi;
  workspaceId: WorkspaceId;
  workspaceName: string;
  bots: readonly BotDefinition[];
}) {
  const t = useT();
  const canManage = useCan("skills.manage", workspaceId).allowed;
  // The static starter catalog and the queue's size arrive with each page of skills.
  const [catalog, setCatalog] = useState<Pick<SkillsView, "starterPack" | "starterSkills">>({
    starterPack: { version: "", sha256: "" },
    starterSkills: [],
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // The search the Gateway answers: the box's text after typing pauses.
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), SKILLS_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const skillPages = usePagedQuery<Skill>({
    scopeKey: `${workspaceId}:${searched}`,
    limit: SKILLS_PAGE_SIZE,
    mode: "offset",
    historyKey: "skills.list",
    fetchPage: async ({ offset, limit }) => {
      const view = await api.listSkills(workspaceId, { q: searched, offset, limit });
      setCatalog({ starterPack: view.starterPack, starterSkills: view.starterSkills });
      return { items: view.skills, total: view.total };
    },
  });
  const pendingPages = usePagedQuery<PendingSkillVersion>({
    scopeKey: workspaceId,
    limit: SKILLS_PAGE_SIZE,
    mode: "cursor",
    historyKey: "skills.pending",
    fetchPage: async ({ cursor, limit }) => {
      const page = await api.listPendingSkillVersions(workspaceId, {
        ...(cursor ? { cursor } : {}),
        limit,
      });
      return {
        items: page.pending,
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  });
  const view = {
    ...catalog,
    skills: skillPages.items,
    pending: pendingPages.items,
  };
  /** The whole queue's size, not this page's. */
  const pendingTotal = pendingPages.page?.total ?? view.pending.length;
  const skillsTotal = skillPages.page?.total ?? view.skills.length;
  const loaded = skillPages.page !== undefined || Boolean(skillPages.error);
  const [selectedId, setSelectedId] = useState<string>();
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnToSkill = useRef<string | undefined>(undefined);
  const closeDetail = () => {
    returnToSkill.current = selectedId;
    setSelectedId(undefined);
  };
  useEffect(() => {
    if (selectedId || !returnToSkill.current) return;
    rowButtons.current.get(returnToSkill.current)?.focus();
    returnToSkill.current = undefined;
  }, [selectedId]);
  const [assigning, setAssigning] = useState<{ skill: Skill; botIds: string[] }>();
  const [installing, setInstalling] = useState(false);
  const installButton = useRef<HTMLButtonElement | null>(null);
  const returnToInstall = useRef(false);
  useEffect(() => {
    if (installing) returnToInstall.current = true;
    else if (!busy && returnToInstall.current) {
      installButton.current?.focus();
      returnToInstall.current = false;
    }
  }, [installing, busy]);
  const mutationPending = useRef(false);
  const live = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again in development.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;

  /** Runs one change and reloads the pages shown, keeping their position. */
  const perform = async (operation: () => Promise<unknown>, done: string) => {
    if (!canManage || mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const said = await operation();
      skillPages.reload();
      pendingPages.reload();
      if (live.current) setNotice(typeof said === "string" ? said : done);
    } catch (err) {
      if (live.current) setError(errorMessage(err));
    } finally {
      mutationPending.current = false;
      if (live.current) setBusy(false);
    }
  };

  const enabledFor = (skill: Skill): string =>
    skill.stage === "provisional" && skill.authorBotId
      ? t("skills.enabled.authorOnly", { bot: botName(skill.authorBotId) })
      : [
          ...(skill.authorBotId ? [skill.authorBotId] : []),
          ...skill.assignments.map((a) => a.botId),
        ]
          .filter((id, i, all) => all.indexOf(id) === i)
          .map(botName)
          .join(", ") || t("skills.enabled.nobody");

  const stageText = (skill: Skill): string => {
    const stage = wordsFor(t, STAGE_TEXT, skill.stage);
    return skill.pinned ? t("skillsPage.statePinned", { stage }) : stage;
  };

  const needle = query.trim().toLowerCase();
  // The workspace's skills are searched by the Gateway; the bundled catalog here.
  const shown = view.skills;
  const shownStarter = needle
    ? view.starterSkills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          skill.description.toLowerCase().includes(needle) ||
          skill.category.toLowerCase().includes(needle),
      )
    : view.starterSkills;
  // The detail stays open, keyed by id, when its row leaves the page shown.
  const lastSelected = useRef<Skill | undefined>(undefined);
  const fresh = view.skills.find((skill) => skill.id === selectedId);
  if (fresh) lastSelected.current = fresh;
  const selected = selectedId
    ? (fresh ?? (lastSelected.current?.id === selectedId ? lastSelected.current : undefined))
    : undefined;

  const menuFor = (skill: Skill) => (
    <ActionMenu
      label={t("skillsPage.moreActions", { name: skill.name })}
      disabled={busy}
      items={[
        {
          id: "details",
          label: t("skillsPage.action.details"),
          onAction: () => setSelectedId(skill.id),
        },
        {
          id: "assign",
          label: t("skills.assign.button"),
          onAction: () => {
            setError("");
            setAssigning({ skill, botIds: skill.assignments.map((a) => a.botId) });
          },
        },
        {
          id: "pin",
          label: skill.pinned ? t("skills.pin.unpin") : t("skills.pin.pin"),
          onAction: () =>
            void perform(
              () => api.updateSkill(skill.id, { pinned: !skill.pinned }),
              skill.pinned
                ? t("skills.notice.unpinned", { name: skill.name })
                : t("skills.notice.pinned", { name: skill.name }),
            ),
        },
        {
          id: "undo",
          label: t("skills.undo.button"),
          disabled: skill.version < 2,
          onAction: () =>
            void perform(
              () => api.undoSkill(skill.id),
              t("skills.notice.undone", { name: skill.name }),
            ),
        },
      ].filter((item) => canManage || item.id === "details")}
    />
  );

  return (
    <section
      className={`workspace-screen resource-page skills-page page-container${selected ? " skill-selected" : ""}`}
      aria-label={t("skills.label")}
    >
      {selected ? (
        <Button className="skills-back" variant="ghost" onClick={closeDetail}>
          {t("skillsPage.back")}
        </Button>
      ) : null}
      <ResourceHeading
        title={t("skills.title")}
        context={t("skillsPage.context", { name: workspaceName })}
        action={
          canManage ? (
            <Button
              variant="primary"
              ref={installButton}
              disabled={installing || busy}
              onClick={() => setInstalling(true)}
            >
              <Plus size={16} aria-hidden="true" /> {t("skillsPage.installButton")}
            </Button>
          ) : undefined
        }
      />

      {!canManage ? <p className="muted small">{t("skillsPage.readOnly")}</p> : null}
      {installing && canManage ? (
        <InstallSkillForm
          bots={bots}
          busy={busy}
          onCancel={() => setInstalling(false)}
          onInstall={(input) =>
            void perform(async () => {
              const installed = await api.installSkill(workspaceId, input);
              if (live.current) setInstalling(false);
              return installed.version.review === "pending"
                ? t("skills.notice.installedHeld", { name: installed.skill.name })
                : t("skills.notice.installedNamed", { name: installed.skill.name });
            }, t("skills.notice.installed"))
          }
        />
      ) : null}

      {skillPages.error ? (
        <div role="alert" className="skills-load-error">
          <p className="error">{errorMessage(skillPages.error)}</p>
          <Button onClick={() => skillPages.reload()}>{t("skillsPage.retrySkills")}</Button>
        </div>
      ) : null}
      {pendingPages.error ? (
        <div role="alert" className="skills-load-error">
          <p className="error">{errorMessage(pendingPages.error)}</p>
          <Button onClick={() => pendingPages.reload()}>{t("skillsPage.retryQueue")}</Button>
        </div>
      ) : null}
      {error && !assigning ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <output className="notice">{notice}</output> : null}

      {view.starterSkills.length > 0 || skillsTotal > 0 || query !== "" || pendingTotal > 0 ? (
        <div className="resource-toolbar">
          <label className="resource-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("skillsPage.search.label")}
              placeholder={t("skillsPage.search.placeholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {view.starterSkills.length > 0 ? (
        <section className="starter-skills" aria-label={t("skills.starter.label")}>
          <div className="resource-section-heading">
            <div>
              <h2>{t("skills.starter.title")}</h2>
              <p className="muted">
                {t("skills.starter.intro", {
                  count: view.starterSkills.length,
                  version: view.starterPack.version,
                })}
              </p>
            </div>
            <Pill tone="success">{t("skills.starter.builtIn")}</Pill>
          </div>
          {shownStarter.length > 0 ? (
            <ul className="resource-list starter-skill-list">
              {shownStarter.map((skill) => (
                <StarterSkillRow key={skill.id} skill={skill} />
              ))}
            </ul>
          ) : (
            <p className="muted resource-status">
              {t("skillsPage.noMatch", { query: query.trim() })}
            </p>
          )}
        </section>
      ) : null}

      {view.pending.length > 0 ? (
        <section className="review-queue" aria-label={t("skills.pending.label")}>
          <h2>{t("skillsPage.review.title", { count: pendingTotal })}</h2>
          <ul>
            {view.pending.map((version) => (
              <PendingVersion
                key={`${version.skillId}@${version.version}`}
                version={version}
                busy={busy || !canManage}
                onConfirm={() =>
                  void perform(
                    () => api.confirmSkillVersion(version.skillId, version.version),
                    t("skills.notice.confirmed", { name: version.name, version: version.version }),
                  )
                }
                onReject={() =>
                  void perform(
                    () => api.rejectSkillVersion(version.skillId, version.version),
                    t("skills.notice.rejected", { name: version.name, version: version.version }),
                  )
                }
              />
            ))}
          </ul>
          <PageBar query={pendingPages} label={t("skillsPage.review.pages")} />
        </section>
      ) : null}

      <div className={`resource-browser${selected ? " has-detail" : ""}`}>
        <div className="resource-list-column">
          {!loaded ? (
            <p className="muted resource-status" aria-busy="true">
              {t("skillsPage.loading")}
            </p>
          ) : skillPages.error ? null : skillsTotal === 0 && !searched ? (
            pendingTotal === 0 && view.starterSkills.length === 0 ? (
              <p className="muted resource-status">{t("skillsPage.empty")}</p>
            ) : null
          ) : shown.length === 0 ? (
            <p className="muted resource-status">
              {t("skillsPage.noMatch", { query: query.trim() })}
            </p>
          ) : (
            <>
              <div className="skill-columns" aria-hidden="true">
                <span>{t("skillsPage.column.skill")}</span>
                <span>{t("skillsPage.column.state")}</span>
                <span>{t("skills.table.enabledFor")}</span>
                <span>{t("skills.table.lastUsed")}</span>
              </div>
              <ul className="resource-list skill-list" aria-label={t("skills.table.label")}>
                {shown.map((skill) => (
                  <li
                    key={skill.id}
                    className={`resource-row skill-row${skill.id === selectedId ? " selected" : ""}`}
                    data-skill={skill.name}
                  >
                    <button
                      type="button"
                      className="resource-row-main"
                      ref={(element) => {
                        if (element) rowButtons.current.set(skill.id, element);
                        else rowButtons.current.delete(skill.id);
                      }}
                      aria-expanded={skill.id === selectedId}
                      onClick={() =>
                        setSelectedId((current) => (current === skill.id ? undefined : skill.id))
                      }
                    >
                      <span className="resource-row-title">{skill.name}</span>
                      <span className="resource-row-meta">{skill.description}</span>
                    </button>
                    <span className="skill-cell">
                      <span className="skill-cell-label">{t("skillsPage.column.state")}</span>
                      <span>{stageText(skill)}</span>
                    </span>
                    <span className="skill-cell">
                      <span className="skill-cell-label">{t("skills.table.enabledFor")}</span>
                      <span>{enabledFor(skill)}</span>
                    </span>
                    <span className="skill-cell">
                      <span className="skill-cell-label">{t("skills.table.lastUsed")}</span>
                      <span>
                        {skill.lastUsedAt
                          ? skill.lastUsedAt.slice(0, 10)
                          : t("skills.lastUsed.never")}
                      </span>
                    </span>
                    <span className="resource-row-badge">
                      {skill.pendingVersions > 0 ? (
                        <Pill tone="warning">
                          {t("skills.waiting", { count: skill.pendingVersions })}
                        </Pill>
                      ) : null}
                    </span>
                    {menuFor(skill)}
                  </li>
                ))}
              </ul>
              <PageBar query={skillPages} label={t("skillsPage.pages")} />
            </>
          )}
        </div>
        {selected ? (
          <SkillDetail
            key={selected.id}
            api={api}
            skill={selected}
            busy={busy || !canManage}
            origin={
              selected.authorBotId
                ? t("skills.origin.byBot", {
                    origin: wordsFor(t, ORIGIN_TEXT, selected.origin),
                    bot: botName(selected.authorBotId),
                  })
                : wordsFor(t, ORIGIN_TEXT, selected.origin)
            }
            enabledFor={enabledFor(selected)}
            onClose={closeDetail}
            onAssign={() => {
              setError("");
              setAssigning({ skill: selected, botIds: selected.assignments.map((a) => a.botId) });
            }}
            onStage={(stage) =>
              void perform(
                () => api.updateSkill(selected.id, { stage }),
                t("skills.notice.stage", {
                  name: selected.name,
                  stage: wordsFor(t, STAGE_TEXT, stage),
                }),
              )
            }
          />
        ) : null}
      </div>

      {assigning ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !mutationPending.current) setAssigning(undefined);
          }}
        >
          <DialogContent
            scroll
            style={{ width: "min(480px, calc(100vw - 24px))" }}
            aria-label={t("skills.assign.label", { name: assigning.skill.name })}
            aria-describedby={undefined}
            aria-labelledby={undefined}
            closeLabel={t("skills.assign.close")}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              rowButtons.current.get(assigning.skill.id)?.focus();
            }}
          >
            <DialogTitle className="mb-4 pr-8 font-semibold">
              {t("skills.assign.title", { name: assigning.skill.name })}
            </DialogTitle>
            {error ? (
              <p role="alert" className="resource-error">
                {error}
              </p>
            ) : null}
            {bots.map((bot) => (
              <label key={bot.id} className="checkbox-row min-h-10">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={assigning.botIds.includes(bot.id)}
                  onChange={(e) =>
                    setAssigning({
                      ...assigning,
                      botIds: e.target.checked
                        ? [...assigning.botIds, bot.id]
                        : assigning.botIds.filter((id) => id !== bot.id),
                    })
                  }
                />
                {bot.name}
              </label>
            ))}
            <div className="resource-detail-actions">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void perform(
                    async () => {
                      await api.assignSkill(
                        assigning.skill.id,
                        assigning.botIds as BotDefinition["id"][],
                      );
                      if (live.current) setAssigning(undefined);
                    },
                    t("skills.notice.assigned", { name: assigning.skill.name }),
                  )
                }
              >
                {t("skills.assign.save")}
              </Button>
              <Button disabled={busy} onClick={() => setAssigning(undefined)}>
                {t("skills.assign.cancel")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

function StarterSkillRow({ skill }: { skill: StarterSkill }) {
  const t = useT();
  return (
    <li className="resource-row starter-skill-row" data-skill={skill.name}>
      <details>
        <summary>
          <span>
            <span className="resource-row-title">{skill.name}</span>
            <span className="resource-row-meta">{skill.description}</span>
          </span>
          <Pill>{skill.category}</Pill>
        </summary>
        <dl className="resource-facts">
          <div>
            <dt>{t("skillsPage.detail.origin")}</dt>
            <dd>{skill.origin}</dd>
          </div>
          <div>
            <dt>{t("skills.starter.license")}</dt>
            <dd>{skill.license}</dd>
          </div>
          <div>
            <dt>{t("skillsPage.detail.version")}</dt>
            <dd>{t("skillsPage.detail.versionValue", { version: skill.version })}</dd>
          </div>
          <div>
            <dt>{t("skillsPage.detail.hash")}</dt>
            <dd>
              <code>{skill.sha256}</code>
            </dd>
          </div>
          <div>
            <dt>{t("skills.table.enabledFor")}</dt>
            <dd>{t("skills.starter.allBots")}</dd>
          </div>
        </dl>
      </details>
    </li>
  );
}

function SkillDetail({
  api,
  skill,
  busy,
  origin,
  enabledFor,
  onClose,
  onAssign,
  onStage,
}: {
  api: SkillsApi;
  skill: Skill;
  busy: boolean;
  origin: string;
  enabledFor: string;
  onClose: () => void;
  onAssign: () => void;
  onStage: (stage: SkillStage) => void;
}) {
  const t = useT();
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => detailRef.current?.focus(), []);
  // Newest first; a long history is read a bounded page at a time with "Load older" (#113).
  const [history, setHistory] = useState<SkillVersion[]>();
  const [olderCursor, setOlderCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const historyRequest = useRef(0);
  const [readRevision, setReadRevision] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [failedPage, setFailedPage] = useState<"newest" | "older">("newest");
  // Reload the history when the current version changes (undo, confirm, a new install).
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and pending count are the triggers.
  useEffect(() => {
    const request = ++historyRequest.current;
    setHistoryError("");
    setLoadingHistory(true);
    setLoadingOlder(false);
    api
      .listSkillVersions(skill.id, { limit: SKILLS_PAGE_SIZE })
      .then((page) => {
        if (request !== historyRequest.current) return;
        setHistory(page.versions);
        setOlderCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (request === historyRequest.current) {
          setHistoryError(errorMessage(err));
          setFailedPage("newest");
        }
      })
      .finally(() => {
        if (request === historyRequest.current) setLoadingHistory(false);
      });
    return () => {
      historyRequest.current += 1;
    };
  }, [api, skill.id, skill.version, skill.pendingVersions, readRevision]);
  const loadOlder = () => {
    if (!olderCursor || loadingOlder || loadingHistory) return;
    const request = ++historyRequest.current;
    setLoadingOlder(true);
    setHistoryError("");
    api
      .listSkillVersions(skill.id, { cursor: olderCursor, limit: SKILLS_PAGE_SIZE })
      .then((page) => {
        if (request !== historyRequest.current) return;
        setHistory((current) => [...(current ?? []), ...page.versions]);
        setOlderCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (request === historyRequest.current) {
          setHistoryError(errorMessage(err));
          setFailedPage("older");
        }
      })
      .finally(() => {
        if (request === historyRequest.current) setLoadingOlder(false);
      });
  };

  return (
    <aside
      ref={detailRef}
      tabIndex={-1}
      className="resource-detail"
      aria-label={t("skillsPage.detail.label")}
    >
      <header className="resource-detail-head">
        <h2>{skill.name}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("skillsPage.detail.close")}
          title={t("skillsPage.detail.close")}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {skill.description ? <p className="resource-detail-body">{skill.description}</p> : null}
      <dl className="resource-facts">
        <dt>{t("skillsPage.detail.stage")}</dt>
        <dd>
          <Select
            aria-label={t("skills.stage.label", { name: skill.name })}
            value={skill.stage}
            disabled={busy}
            onValueChange={(value) => onStage(value as SkillStage)}
            options={SKILL_STAGES.map((stage) => ({
              value: stage,
              label: wordsFor(t, STAGE_TEXT, stage),
            }))}
          />
        </dd>
        <dt>{t("skills.table.enabledFor")}</dt>
        <dd>{enabledFor}</dd>
        <dt>{t("skillsPage.detail.version")}</dt>
        <dd>
          {skill.version > 0
            ? t("skillsPage.detail.versionValue", { version: skill.version })
            : null}
          {skill.pinned ? ` · ${t("skills.pinned")}` : null}
        </dd>
      </dl>
      <div className="resource-detail-actions">
        <Button disabled={busy} onClick={onAssign}>
          {t("skills.assign.button")}
        </Button>
      </div>
      <details className="skill-audit">
        <summary>{t("skillsPage.detail.audit")}</summary>
        <dl className="resource-facts">
          <dt>{t("skillsPage.detail.origin")}</dt>
          <dd>{origin}</dd>
          <dt>{t("skillsPage.detail.hash")}</dt>
          <dd>
            <code className="resource-hash">{skill.sha256 ?? t("skills.sha.none")}</code>
          </dd>
          <dt>{t("skillsPage.detail.provenance")}</dt>
          <dd>{skill.provenance ?? t("skillsPage.detail.provenanceNone")}</dd>
          <dt>{t("skillsPage.detail.listedSince")}</dt>
          <dd>{skill.listedSince.slice(0, 10)}</dd>
        </dl>
      </details>
      <section className="resource-versions" aria-label={t("skillsPage.history.label")}>
        <h3>{t("skillsPage.history.label")}</h3>
        {historyError ? (
          <p role="alert" className="error">
            {historyError}{" "}
            <Button
              disabled={loadingHistory || loadingOlder}
              onClick={() =>
                failedPage === "older" ? loadOlder() : setReadRevision((value) => value + 1)
              }
            >
              {t("skillsPage.history.retry")}
            </Button>
          </p>
        ) : null}
        {history === undefined && loadingHistory ? (
          <p className="muted small">{t("skillsPage.history.loading")}</p>
        ) : null}
        {history ? (
          <ol>
            {history.map((version) => (
              <li key={version.version}>
                <span>
                  {t("skillsPage.history.row", {
                    version: version.version,
                    op: wordsFor(t, OP_TEXT, version.op),
                    by: version.by,
                    date: version.createdAt.slice(0, 10),
                    review: wordsFor(t, REVIEW_TEXT, version.review),
                  })}
                </span>
                <span className="muted small">
                  <code>{short(version.sha256, t("skills.sha.none"))}</code>
                </span>
                <FindingList version={version} />
              </li>
            ))}
          </ol>
        ) : null}
        {history && olderCursor ? (
          <Button disabled={loadingOlder || loadingHistory} onClick={loadOlder}>
            {t("skillsPage.history.loadOlder")}
          </Button>
        ) : null}
      </section>
    </aside>
  );
}

function FindingList({ version }: { version: SkillVersion }) {
  const t = useT();
  if (version.holdReasons.length === 0 && version.findings.length === 0) return null;
  return (
    <ul className="muted small skill-findings">
      {version.review === "pending"
        ? version.holdReasons.map((reason) => (
            <li key={reason}>
              {t("skills.pendingVersion.held", { reason: wordsFor(t, HOLD_TEXT, reason) })}
            </li>
          ))
        : null}
      {version.findings.map((finding) => {
        const kind = wordsFor(t, FINDING_TEXT, finding.kind, finding.kind.replaceAll("_", " "));
        return (
          <li key={`${finding.kind}:${finding.path}:${finding.line ?? 0}:${finding.detail}`}>
            {finding.line
              ? t("skills.pendingVersion.findingAtLine", {
                  kind,
                  path: finding.path,
                  line: finding.line,
                  detail: finding.detail,
                })
              : t("skills.pendingVersion.finding", {
                  kind,
                  path: finding.path,
                  detail: finding.detail,
                })}
          </li>
        );
      })}
    </ul>
  );
}

function InstallSkillForm({
  bots,
  busy,
  onCancel,
  onInstall,
}: {
  bots: readonly BotDefinition[];
  busy: boolean;
  onCancel: () => void;
  onInstall: (input: {
    files: SkillFile[];
    sha256: string;
    provenance?: string;
    botIds: BotDefinition["id"][];
  }) => void;
}) {
  const t = useT();
  const none = t("skills.sha.none");
  const contentInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    contentInput.current?.focus();
  }, []);
  const [skillMd, setSkillMd] = useState("");
  const [expectedSha, setExpectedSha] = useState("");
  const [computedSha, setComputedSha] = useState("");
  const [provenance, setProvenance] = useState("");
  const [installFor, setInstallFor] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    if (skillMd.trim() === "") {
      setComputedSha("");
      return;
    }
    skillSha256([{ path: "SKILL.md", content: skillMd }])
      .then((sha) => active && setComputedSha(sha))
      .catch(() => active && setComputedSha(""));
    return () => {
      active = false;
    };
  }, [skillMd]);
  const front = parseSkillFrontmatter(skillMd);
  return (
    <section aria-label={t("skills.install.label")} className="card resource-form">
      <h2>{t("skills.install.title")}</h2>
      <p className="muted small">{t("skills.install.intro")}</p>
      <label>
        {t("skills.install.skillMd")}
        <textarea
          ref={contentInput}
          disabled={busy}
          aria-label={t("skills.install.skillMd")}
          rows={8}
          value={skillMd}
          onChange={(e) => setSkillMd(e.target.value)}
          placeholder={t("skills.install.skillMdPlaceholder")}
        />
      </label>
      <p className="muted small">
        {front
          ? t("skills.install.frontmatter", { name: front.name, description: front.description })
          : t("skills.install.frontmatterMissing")}{" "}
        {t.rich("skills.install.contentHash", {
          sha: computedSha || none,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <label>
        {t("skills.install.reviewedSha")}
        <input
          disabled={busy}
          aria-label={t("skills.install.reviewedSha")}
          value={expectedSha}
          onChange={(e) => setExpectedSha(e.target.value.trim())}
          placeholder={t("skills.install.reviewedShaPlaceholder")}
        />
      </label>
      <label>
        {t("skills.install.provenance")}
        <input
          disabled={busy}
          aria-label={t("skills.install.provenance")}
          value={provenance}
          onChange={(e) => setProvenance(e.target.value)}
          placeholder={t("skills.install.provenancePlaceholder")}
        />
      </label>
      {bots.map((bot) => (
        <label key={bot.id} className="checkbox-row">
          <input
            disabled={busy}
            type="checkbox"
            aria-label={t("skills.install.for", { name: bot.name })}
            checked={installFor.includes(bot.id)}
            onChange={(e) =>
              setInstallFor(
                e.target.checked
                  ? [...installFor, bot.id]
                  : installFor.filter((id) => id !== bot.id),
              )
            }
          />
          {bot.name}
        </label>
      ))}
      <div className="resource-detail-actions">
        <Button
          variant="primary"
          disabled={busy || !front || expectedSha === ""}
          onClick={() =>
            onInstall({
              files: [{ path: "SKILL.md", content: skillMd }],
              sha256: expectedSha,
              ...(provenance.trim() ? { provenance: provenance.trim() } : {}),
              botIds: installFor as BotDefinition["id"][],
            })
          }
        >
          {t("skills.install.button")}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          {t("skillsPage.install.cancel")}
        </Button>
      </div>
    </section>
  );
}

function PendingVersion({
  version,
  busy,
  onConfirm,
  onReject,
}: {
  version: SkillVersion & { name: string };
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const t = useT();
  const skillMd = version.files.find((f) => f.path === "SKILL.md")?.content ?? "";
  return (
    <li className="review-row" data-pending={`${version.name}@${version.version}`}>
      <div className="review-row-text">
        <p className="review-row-body">
          <strong>
            {t("skills.pendingVersion.title", { name: version.name, version: version.version })}
          </strong>{" "}
          <span className="muted small">
            {t("skills.pendingVersion.meta", {
              op: wordsFor(t, OP_TEXT, version.op),
              by: version.by,
              sha: short(version.sha256, t("skills.sha.none")),
            })}
          </span>
        </p>
        <FindingList version={version} />
        <details>
          <summary>{t("skills.pendingVersion.content")}</summary>
          <pre>{skillMd}</pre>
          {version.files.length > 1 ? (
            <p className="muted small">
              {t("skills.pendingVersion.otherFiles", {
                files: version.files
                  .filter((f) => f.path !== "SKILL.md")
                  .map((f) => f.path)
                  .join(", "),
              })}
            </p>
          ) : null}
        </details>
      </div>
      <div className="review-row-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
          {t("skills.pendingVersion.confirm")}
        </Button>
        <Button size="sm" disabled={busy} onClick={onReject}>
          {t("skills.pendingVersion.reject")}
        </Button>
      </div>
    </li>
  );
}
