// Contacts: the bots of the current workspace, the way a messaging app lists people. A contact
// opens its private chat (the existing one-member thread, or a new one) or its profile. A link
// to a bot in another workspace switches to that workspace first.

import {
  type BotAvatar,
  type BotDefinition,
  type BotId,
  type RunStatus,
  type ThreadSummary,
  type Workspace,
  isOwnSideChat,
} from "@deskmates/contracts";
import { ButtonLink, Card } from "@deskmates/ui";
import { MessageSquare, Search, UserRoundPlus } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { EmptyState } from "../../components/ui/empty-state.js";
import { RunStatusPill } from "../../components/ui/pill.js";
import { errorMessage, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { contactHref, navigate, threadHref } from "../../router.js";
import { useRememberBots } from "../../state/bot-avatars.js";
import { NextAction, RoleNote, useCan, useSessionActor } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { memberIdsOf } from "../chats/thread-rail.js";
import { AvatarPicker } from "./avatar-picker.js";
import { BotProfile } from "./bot-profile.js";
import { SoulProposalPanel } from "./soul-proposal.js";

/** The newest run of each bot, which is what "what is it doing" means here. */
/** Bots per rail page (#113 slice B, plan row 29) and the search debounce. */
export const CONTACT_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

export function latestRunByBot(runs: readonly RunView[]): Map<string, RunView> {
  const latest = new Map<string, RunView>();
  for (const run of runs) {
    const current = latest.get(run.botId);
    if (!current || run.createdAt >= current.createdAt) latest.set(run.botId, run);
  }
  return latest;
}

/** The one-member chat thread of a bot, if the operator already has one. */
export function privateChatOf(
  threads: readonly ThreadSummary[],
  botId: BotId,
): ThreadSummary | undefined {
  return threads
    .filter(
      (thread) =>
        thread.kind === "chat" &&
        memberIdsOf(thread).length === 1 &&
        memberIdsOf(thread)[0] === botId,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export async function openPrivateChat(api: ApiClient, bot: BotDefinition): Promise<void> {
  const { thread } = await api.resolvePrivateChat(bot.id);
  navigate(threadHref(thread.id));
}

/**
 * A Member's way to talk to a bot (ADR-0022 amendment 1): their own latest side chat with it,
 * or a new one. The bot's canonical private chat and the group chats are the Admins'.
 */
export async function openSideChat(
  api: ApiClient,
  bot: BotDefinition,
  actorId: string | undefined,
): Promise<void> {
  const own = (await api.listThreads(bot.workspaceId))
    .filter(
      (thread) =>
        actorId !== undefined &&
        isOwnSideChat(thread, memberIdsOf(thread).length, actorId) &&
        memberIdsOf(thread)[0] === bot.id,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const thread =
    own ?? (await api.createThread({ workspaceId: bot.workspaceId, botIds: [bot.id] })).thread;
  navigate(threadHref(thread.id));
}

export function ContactsScreen({
  api,
  botId,
  creatingNew = false,
}: {
  api: ApiClient;
  botId?: string | undefined;
  creatingNew?: boolean;
}) {
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const rememberBots = useRememberBots();
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);
  const [runs, setRuns] = useState<readonly RunView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string>();
  const [creating, setCreating] = useState(false);
  const canCreateBot = useCan("bot.create");
  const canCreateWorkspace = useCan("workspace.create");
  const canOpenPrivateChat = useCan("privateChat.open");
  const canReadRuns = useCan("runs.read").allowed;
  const actorId = useSessionActor();
  const t = useT();

  useEffect(() => {
    if (creatingNew && workspace && canCreateBot.allowed) setCreating(true);
  }, [creatingNew, workspace, canCreateBot.allowed]);

  useEffect(() => {
    let active = true;
    api
      .listBots()
      .then((b) => {
        if (!active) return;
        setBots(b);
        rememberBots(b);
        setError(undefined);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)))
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [api, rememberBots]);

  // #113 slice R: each bot's newest run comes from a per-workspace summary, never from every run
  // of the tenant.
  const workspaceId = workspace?.id;
  useEffect(() => {
    let active = true;
    setRuns([]);
    // A Guest reads no runs (ADR-0022 amendment 6 W6): no "latest run" line, and no failure.
    if (!workspaceId || !canReadRuns) return;
    api
      .latestRunsByBot(workspaceId)
      .then((r) => active && setRuns(r))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, workspaceId, canReadRuns]);

  const latest = useMemo(() => latestRunByBot(runs), [runs]);
  const members = workspace ? bots.filter((b) => b.workspaceId === workspace.id) : bots;
  // #113 slice B: the rail is one page of the workspace's bots by name, searched on the server.
  // The whole bot list above stays the name map (and the selected profile's lookup).
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const pages = usePagedQuery<BotDefinition>({
    scopeKey: `contacts.bots:${workspace?.id ?? ""}:${search}:${bots.length}`,
    limit: CONTACT_PAGE_SIZE,
    mode: "offset",
    historyKey: "contacts.bots",
    fetchPage: async ({ offset, limit }) => {
      if (!workspace) return { items: [], total: 0 };
      const page = await api.listBotPage(workspace.id, {
        offset,
        limit,
        ...(search ? { q: search } : {}),
      });
      return { items: page.bots, total: page.total };
    },
  });
  const reloadPage = pages.reload;
  // A saved profile updates its row at once; the next page load agrees.
  const visible = pages.items.map((b) => bots.find((item) => item.id === b.id) ?? b);
  const selected = botId ? bots.find((b) => b.id === botId) : undefined;
  const { select } = scope;
  useEffect(() => {
    if (selected && workspace && selected.workspaceId !== workspace.id)
      select(selected.workspaceId);
  }, [selected, workspace, select]);

  const message = async (bot: BotDefinition) => {
    setOpening(bot.id);
    try {
      if (canOpenPrivateChat.allowed) await openPrivateChat(api, bot);
      else await openSideChat(api, bot, actorId);
    } catch (err) {
      setError(errorMessage(err));
      setOpening(undefined);
    }
  };

  return (
    <div className={`contacts-screen${selected ? " has-profile" : ""}`}>
      <aside className="rail">
        <div className="rail-heading">
          <h2>{t("contacts.heading")}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("contacts.newContact.label")}
            title={
              canCreateBot.allowed
                ? undefined
                : t("contacts.newContact.onlyWho", { who: canCreateBot.who })
            }
            disabled={!workspace || !canCreateBot.allowed}
            onClick={() => setCreating(true)}
          >
            <UserRoundPlus size={18} />
          </button>
        </div>
        {members.length > 3 ? (
          <div className="rail-search">
            <Search size={15} />
            <input
              type="search"
              aria-label={t("contacts.search.label")}
              placeholder={t("contacts.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}
        <div className="rail-scroll">
          {error ? <p className="error small thread-empty">{error}</p> : null}
          {loaded && scope.loaded && members.length === 0 ? (
            <div className="thread-empty">
              <p className="muted">
                {workspace
                  ? t("contacts.empty.noBots", { workspace: workspace.name })
                  : t("contacts.empty.noWorkspace")}
              </p>
              {workspace ? (
                <NextAction
                  action="bot.create"
                  does={t("contacts.next.addBot.does")}
                  how={t("contacts.next.addBot.how")}
                />
              ) : (
                <NextAction
                  action="workspace.create"
                  does={t("contacts.next.createWorkspace.does")}
                  how={t("contacts.next.createWorkspace.how")}
                />
              )}
            </div>
          ) : null}
          <ul className="contact-list">
            {visible.map((b) => {
              const run = latest.get(b.id);
              return (
                <li key={b.id} className={b.id === botId ? "selected" : ""}>
                  <a href={contactHref(b.id)} className="contact-row">
                    <Avatar name={b.name} />
                    <span className="contact-main">
                      <span className="contact-heading">
                        <span className="contact-name">{b.name}</span>
                        {run ? (
                          <span className="muted small contact-time">
                            {formatRelative(run.finishedAt ?? run.startedAt ?? run.createdAt)}
                          </span>
                        ) : null}
                      </span>
                      <span className="muted small contact-role">
                        {b.role || t("contacts.row.noRole")}
                      </span>
                    </span>
                    <span className="contact-status">
                      {run ? (
                        <StatusDot status={run.status} />
                      ) : (
                        <span className="muted small">{t("contacts.row.neverRan")}</span>
                      )}
                    </span>
                  </a>
                  <div className="contact-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("contacts.row.messageLabel", { name: b.name })}
                      title={t("contacts.row.messageTitle")}
                      disabled={opening === b.id}
                      onClick={() => void message(b)}
                    >
                      <MessageSquare size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <PageBar query={pages} label={t("contacts.pages")} />
        </div>
      </aside>
      <section className="contacts-main">
        {selected ? (
          <BotProfile
            api={api}
            bot={selected}
            workspace={scope.workspaces.find((w) => w.id === selected.workspaceId)}
            latestRun={latest.get(selected.id)}
            onMessage={() => void message(selected)}
            onSaved={(saved) => {
              setBots((items) => items.map((item) => (item.id === saved.id ? saved : item)));
              rememberBots([saved]);
              reloadPage();
            }}
          />
        ) : members.length > 0 ? (
          <div className="team-overview">
            <span className="eyebrow">{workspace?.name}</span>
            <h1>{t("contacts.team.title")}</h1>
            <p>{t("contacts.team.intro")}</p>
            <div className="team-card-grid">
              {visible.map((bot) => (
                <Card key={bot.id} className="team-card">
                  <Avatar name={bot.name} size="lg" />
                  <h2>{bot.name}</h2>
                  <p>{bot.role || t("contacts.team.ready")}</p>
                  {latest.get(bot.id) ? (
                    <RunStatusPill status={latest.get(bot.id)?.status ?? "queued"} />
                  ) : (
                    <p>{t("contacts.team.noActivity")}</p>
                  )}
                  <div className="team-card-actions">
                    <Button
                      aria-label={t("contacts.team.chatWith", { name: bot.name })}
                      onClick={() => void message(bot)}
                      disabled={opening === bot.id}
                    >
                      <MessageSquare size={16} />
                      {t("contacts.team.chat")}
                    </Button>
                    <ButtonLink href={contactHref(bot.id)} variant="ghost">
                      {t("contacts.team.profile")}
                    </ButtonLink>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ) : (
          <div className="contacts-empty">
            <EmptyState icon={<UserRoundPlus size={22} />} title={t("contacts.pick.title")}>
              {t("contacts.pick.body")}
              {workspace && members.length === 0 ? (
                <>
                  <Button
                    variant="default"
                    className="mt-3"
                    disabled={!canCreateBot.allowed}
                    onClick={() => setCreating(true)}
                  >
                    {t("contacts.pick.addFirst", { workspace: workspace.name })}
                  </Button>
                  <RoleNote action="bot.create" does={t("contacts.next.addBot.does")} />
                </>
              ) : null}
              {scope.loaded && !workspace ? (
                <>
                  <Button
                    variant="default"
                    className="mt-3"
                    disabled={!canCreateWorkspace.allowed}
                    onClick={scope.openCreate}
                  >
                    {t("contacts.pick.createWorkspaceFirst")}
                  </Button>
                  <RoleNote
                    action="workspace.create"
                    does={t("contacts.next.createWorkspace.does")}
                  />
                </>
              ) : null}
            </EmptyState>
          </div>
        )}
      </section>
      <NewContactDialog
        api={api}
        open={creating && workspace !== undefined}
        workspace={workspace}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setBots((items) => [...items, created]);
          rememberBots([created]);
          setCreating(false);
          navigate(contactHref(created.id));
        }}
      />
    </div>
  );
}

/** A bot is a teammate: a name people will @mention and a one-line role. Instructions come next. */
function NewContactDialog({
  api,
  open,
  workspace,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  open: boolean;
  workspace: Workspace | undefined;
  onClose: () => void;
  onCreated: (bot: BotDefinition) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [avatar, setAvatar] = useState<BotAvatar>();
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [describe, setDescribe] = useState("");
  // Issue #77: a bot created for a drafted SOUL, unstarted until the draft is applied or skipped.
  const [drafting, setDrafting] = useState<{ bot: BotDefinition; version: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = useT();
  const reset = () => {
    setName("");
    setRole("");
    setDescribe("");
    setAvatar(undefined);
    setPickingAvatar(false);
    setDrafting(undefined);
  };
  const start = async (bot: BotDefinition) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.startWelcome(bot.id);
      reset();
      onCreated(bot);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace) return;
    setBusy(true);
    setError(undefined);
    try {
      const draft = describe.trim() !== "";
      const bot = await api.createBot({
        name: name.trim(),
        workspaceId: workspace.id,
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(avatar ? { avatar } : {}),
        ...(draft ? { welcome: false } : {}),
      });
      if (draft) {
        const soul = await api.getSoul(bot.id);
        setDrafting({ bot, version: soul.version });
        return;
      }
      reset();
      onCreated(bot);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    // Closing keeps the bot, unstarted and without the draft; nothing else is applied.
    const created = drafting?.bot;
    reset();
    if (created) onCreated(created);
    else onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? close() : undefined)}>
      <DialogContent className="max-w-md" closeLabel={t("contacts.dialog.close")}>
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("contacts.dialog.title")}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("contacts.dialog.description", {
            workspace: workspace?.name ?? t("contacts.dialog.thisWorkspace"),
          })}
        </DialogDescription>
        {drafting ? (
          <div className="stack">
            <h4>{t("contacts.dialog.reviewTitle")}</h4>
            <SoulProposalPanel
              api={api}
              bot={drafting.bot}
              loadedVersion={drafting.version}
              initialInstruction={describe}
              autoStart
              onApplied={() => void start(drafting.bot)}
            />
            {error ? <p className="error small">{error}</p> : null}
            <Button type="button" disabled={busy} onClick={() => void start(drafting.bot)}>
              {t("contacts.dialog.startWithout")}
            </Button>
          </div>
        ) : (
          <form className="stack" onSubmit={submit} aria-label={t("contacts.dialog.formLabel")}>
            <div className="new-contact-identity">
              <button
                type="button"
                className="avatar-button"
                aria-label={
                  pickingAvatar
                    ? t("contacts.dialog.hideAvatars")
                    : t("contacts.dialog.chooseAvatar")
                }
                aria-expanded={pickingAvatar}
                onClick={() => setPickingAvatar((v) => !v)}
              >
                <Avatar name={name || "bot"} avatar={avatar} size="lg" />
              </button>
              <label>
                {t("contacts.dialog.handle")}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  pattern="[A-Za-z0-9_\-]+"
                  placeholder={t("contacts.dialog.handlePlaceholder")}
                  required
                />
              </label>
            </div>
            {pickingAvatar ? (
              <AvatarPicker
                name={name || "bot"}
                value={avatar}
                onChange={setAvatar}
                showPreview={false}
              />
            ) : null}
            <label>
              {t("contacts.dialog.role")}
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder={t("contacts.dialog.rolePlaceholder")}
              />
            </label>
            <label>
              {t("contacts.dialog.draftRole")}
              <input
                value={describe}
                maxLength={2000}
                onChange={(e) => setDescribe(e.target.value)}
                placeholder={t("contacts.dialog.draftRolePlaceholder")}
              />
            </label>
            {describe.trim() ? (
              <p className="muted small">{t("contacts.dialog.draftRoleHelp")}</p>
            ) : null}
            {error ? <p className="error small">{error}</p> : null}
            <Button type="submit" variant="default" disabled={busy || !workspace || !name.trim()}>
              {t("contacts.dialog.create")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusDot({ status }: { status: RunStatus }) {
  return <RunStatusPill status={status} />;
}
