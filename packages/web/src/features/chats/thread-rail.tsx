// Left rail of the chats screen, in the shape of a messaging app: private chats and groups with
// the newest message as a preview, bot-to-bot (`bus`) threads folded under their own heading,
// a search field, and the forms that start a conversation. Everything here belongs to the
// current workspace. With an empty database the first-run form creates a workspace, one bot and
// the thread in one go so an operator can reach a chat without touching the API by hand.

import type {
  BotDefinition,
  BotId,
  Thread,
  ThreadId,
  ThreadSummary,
  Workspace,
} from "@deskmates/contracts";
import { CHAT_THREAD_MAX_MEMBERS, EGRESS_OPEN_INTERNET, isOwnSideChat } from "@deskmates/contracts";
import { ActionMenu } from "@deskmates/ui";
import { Bot as BotIcon, Plus, Search, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { Avatar, AvatarStack } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage, formatRelative, splitList } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { navigate, newContactHref, threadHref } from "../../router.js";
import { NextAction, useCan, useSessionActor } from "../../state/session-roles.js";
import { EgressModePicker } from "../workspaces/egress-mode-picker.js";

const RAIL_SEARCH_DEBOUNCE_MS = 250;

export interface ThreadRailProps {
  /** The current workspace; its chats and bots are the only ones shown. Undefined: none yet. */
  workspace: Workspace | undefined;
  bots: readonly BotDefinition[];
  threads: readonly ThreadSummary[];
  selectedId?: ThreadId | undefined;
  /** Called with the new thread and any registry rows the form created. */
  onCreated: (created: { thread: Thread; workspace?: Workspace; bot?: BotDefinition }) => void;
  /**
   * Called when a click resolved a bot's canonical private chat in the current workspace, before
   * the rail navigates to it, so the screen can list it at once (ADR-0024 decision 6).
   */
  onPrivateChat?: (opened: { thread: Thread; botId: BotId }) => void;
  /** Reload the workspace-shared pin order after a row action. */
  onPinsChanged?: () => void;
  /** Older conversations exist beyond the loaded rail pages (#113 slice CH). */
  more?: { loading: boolean; onLoad: () => void } | undefined;
  /**
   * Conversations the Gateway found for a search, including ones beyond the loaded pages
   * (#113 slice CH); the screen lists them, and the rail filters as it always has.
   */
  onSearchResults?: (threads: readonly ThreadSummary[]) => void;
  api?: ApiClient;
}

/** Older Gateways and test fixtures list threads without members. */
export function memberIdsOf(thread: Thread | ThreadSummary): readonly BotId[] {
  return (thread as Partial<ThreadSummary>).memberIds ?? [];
}

/**
 * A chat is named after its title, or, like a messaging app, after who is in it: the bot's name
 * for a private chat, the members' names for a group with no title of its own.
 */
export function chatTitle(
  thread: Thread | ThreadSummary,
  botName: (id: BotId) => string | undefined,
): string {
  if (thread.title) return thread.title;
  return namesTitle(memberIdsOf(thread).map((id) => botName(id as BotId) ?? id));
}

/** "chief, researcher, qa" or "chief, researcher +2"; "Chat" when nobody is in it yet. */
export function namesTitle(names: readonly string[], max = 3): string {
  const { t } = currentI18n();
  if (names.length === 0) return t("threadRail.namesTitle.empty");
  if (names.length <= max) return names.join(", ");
  return t("threadRail.namesTitle.more", {
    names: names.slice(0, max).join(", "),
    count: names.length - max,
  });
}

/** One entry per bot: its canonical private chat when the Gateway lists one, else unopened. */
export interface InboxEntry {
  bot: BotDefinition;
  thread?: ThreadSummary;
  /**
   * Other one-member chats with this bot (retained histories and task chats), nested under it in
   * recency order and labelled without chronology (ADR-0024 amendment 2, decision 12).
   */
  earlier: ThreadSummary[];
}

export interface RailSections {
  inboxes: InboxEntry[];
  groups: ThreadSummary[];
  bus: ThreadSummary[];
}

/**
 * Splits the workspace's conversations the way the rail shows them (ADR-0024 decision 6): one
 * private entry per bot, using the chat the Gateway marks as that bot's canonical inbox
 * (`privateChatBotId`), then groups and bot-to-bot threads. Older one-member chats remain
 * available under their bot; there is deliberately no catch-all "Other chats" section.
 * Inboxes with a chat keep the list's recency order; unopened ones follow in bot order.
 */
/** A one-bot chat that is this actor's own: private to them, or a side chat they opened. */
function isOwnPrivateChat(thread: ThreadSummary, actor: string): boolean {
  return (
    thread.kind === "chat" &&
    memberIdsOf(thread).length === 1 &&
    ((thread.privateToUserId !== undefined && `user:${thread.privateToUserId}` === actor) ||
      isOwnSideChat(thread, 1, actor))
  );
}

export function railSections(
  bots: readonly BotDefinition[],
  threads: readonly ThreadSummary[],
  /**
   * The viewer's actor label (`user:<id>`) when they act below Admin: their entry for a bot is
   * then their own private chat with it, and the bot's canonical chat is one of its earlier
   * chats (ADR-0022 amendment 7 S7). Absent: the canonical chat leads, as for an Admin.
   */
  ownActor?: string,
): RailSections {
  const listed = new Map(bots.map((b) => [b.id, b]));
  const canonical = new Map<BotId, ThreadSummary>();
  for (const thread of threads) {
    const botId =
      ownActor === undefined
        ? thread.privateChatBotId
        : isOwnPrivateChat(thread, ownActor)
          ? memberIdsOf(thread)[0]
          : undefined;
    if (thread.kind !== "chat" || !botId || !listed.has(botId) || canonical.has(botId)) continue;
    canonical.set(botId, thread);
  }
  const oneMember = new Map<BotId, ThreadSummary[]>();
  for (const thread of threads) {
    const ids = memberIdsOf(thread);
    // Compatibility for old Gateways and fixtures that omitted memberIds: in a one-bot
    // workspace there is only one possible private-chat owner.
    const inferred = ids.length === 0 && bots.length === 1;
    const botId = ids[0] ?? (inferred ? bots[0]?.id : undefined);
    if (thread.kind !== "chat" || (ids.length !== 1 && !inferred) || !botId || !listed.has(botId))
      continue;
    oneMember.set(botId, [...(oneMember.get(botId) ?? []), thread]);
  }
  const inboxes = bots.map((bot): InboxEntry => {
    const histories = oneMember.get(bot.id) ?? [];
    // Below Admin an entry without the viewer's own chat stays unopened: the click creates it.
    const thread = canonical.get(bot.id) ?? (ownActor === undefined ? histories[0] : undefined);
    return {
      bot,
      ...(thread ? { thread } : {}),
      earlier: histories.filter((candidate) => candidate.id !== thread?.id),
    };
  });
  const used = new Set(
    inboxes.flatMap(({ thread, earlier }) =>
      [thread, ...earlier].flatMap((x) => (x ? [x.id] : [])),
    ),
  );
  const rest = threads.filter((thread) => !used.has(thread.id));
  return {
    inboxes: inboxes.sort((a, b) =>
      (b.thread?.updatedAt ?? "").localeCompare(a.thread?.updatedAt ?? ""),
    ),
    groups: rest.filter((thread) => thread.kind !== "bus" && memberIdsOf(thread).length > 1),
    bus: rest.filter((thread) => thread.kind === "bus"),
  };
}

function without<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export function ThreadRail(props: ThreadRailProps) {
  const { workspace, bots, threads, selectedId } = props;
  const api = props.api ?? defaultApi;
  const t = useT();
  const canCreateWorkspace = useCan("workspace.create");
  const canOpenPrivateChat = useCan("privateChat.open").allowed;
  const actorId = useSessionActor();
  const [query, setQuery] = useState("");
  // The search also asks the Gateway, so a match beyond the loaded pages is found; the newest
  // search wins and a cleared one asks nothing.
  const onSearchResults = props.onSearchResults;
  const searchWorkspaceId = workspace?.id;
  useEffect(() => {
    const text = query.trim();
    if (!text || !searchWorkspaceId || !onSearchResults) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .listThreadPage(searchWorkspaceId, { q: text })
        .then((page) => current && onSearchResults(page.threads))
        .catch(() => {
          // The local filter still answers; a failed server search is not worth an error.
        });
    }, RAIL_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, query, searchWorkspaceId, onSearchResults]);
  const [pinning, setPinning] = useState<ReadonlySet<ThreadId>>(() => new Set());
  const [pinError, setPinError] = useState<string>();
  // With neither a bot nor a chat the create dialog is the next step, so it opens by itself.
  // Once the workspace has bots, their inboxes are the way in and nothing is forced open.
  const nothing = threads.length === 0 && bots.length === 0;
  const canCreateThread = useCan("thread.create").allowed;
  const canCreateBotHere = useCan("bot.create").allowed;
  const canCreateSomething = canCreateThread || canCreateBotHere;
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => {
    if (nothing && workspace && canCreateSomething) setCreateOpen(true);
  }, [nothing, workspace, canCreateSomething]);

  const botById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const botName = useCallback((id: BotId) => botById.get(id)?.name, [botById]);

  // Opening an unopened inbox: only an explicit click asks the Gateway's resolver, once per bot
  // at a time. A resolution that finishes after the workspace changed or the rail unmounted is
  // dropped: no navigation, no row.
  const workspaceId = workspace?.id;
  const [opening, setOpening] = useState<ReadonlyMap<BotId, true>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlyMap<BotId, string>>(() => new Map());
  const inFlight = useRef(new Set<BotId>());
  const scope = useRef({ workspaceId, generation: 0 });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    scope.current = { workspaceId, generation: scope.current.generation + 1 };
    inFlight.current = new Set();
    setOpening(new Map());
    setFailed(new Map());
  }, [workspaceId]);

  const openInbox = async (bot: BotDefinition) => {
    if (!workspaceId || bot.workspaceId !== workspaceId || inFlight.current.has(bot.id)) return;
    const started = scope.current.generation;
    const current = () => live.current && scope.current.generation === started;
    const from = window.location.hash;
    const pending = inFlight.current;
    pending.add(bot.id);
    setOpening((m) => new Map(m).set(bot.id, true));
    setFailed((m) => without(m, bot.id));
    try {
      // Opening a bot's canonical inbox is an Admin's; a Member talks to the bot in a side chat
      // of their own instead, reused when they have one (ADR-0022 amendment 1).
      const canonical = canOpenPrivateChat;
      const own = canonical
        ? undefined
        : threads.find(
            (candidate) =>
              actorId !== undefined &&
              isOwnPrivateChat(candidate, actorId) &&
              memberIdsOf(candidate)[0] === bot.id,
          );
      const thread = canonical
        ? (await api.resolvePrivateChat(bot.id)).thread
        : (own ?? (await api.createThread({ workspaceId, botIds: [bot.id] })).thread);
      if (!current()) return;
      if (thread.workspaceId !== workspaceId) throw new Error(t("threadRail.inbox.otherWorkspace"));
      if (canonical) props.onPrivateChat?.({ thread, botId: bot.id });
      // The operator may have opened something else meanwhile; that choice wins.
      if (window.location.hash === from) navigate(threadHref(thread.id));
    } catch (err) {
      if (current()) setFailed((m) => new Map(m).set(bot.id, errorMessage(err)));
    } finally {
      pending.delete(bot.id);
      if (current()) setOpening((m) => without(m, bot.id));
    }
  };

  const ownActor = canOpenPrivateChat ? undefined : actorId;
  const sections = useMemo(() => railSections(bots, threads, ownActor), [bots, threads, ownActor]);
  const q = query.trim().toLocaleLowerCase();
  const threadText = (thread: ThreadSummary) =>
    [
      chatTitle(thread, botName),
      ...memberIdsOf(thread).map((id) => botName(id) ?? ""),
      thread.lastMessage?.excerpt ?? "",
      thread.lastHandoff?.excerpt ?? "",
    ].join(" ");
  const matches = (text: string) => !q || text.toLocaleLowerCase().includes(q);
  const visibleInboxes = sections.inboxes.filter(({ bot, thread, earlier }) =>
    matches(
      `${bot.name} ${bot.role} ${thread ? threadText(thread) : ""} ${earlier.map(threadText).join(" ")}`,
    ),
  );
  const visibleGroups = sections.groups.filter((thread) => matches(threadText(thread)));
  const pinnedInboxes = visibleInboxes
    .filter(({ thread }) => thread?.pinPosition !== undefined)
    .sort((a, b) => (a.thread?.pinPosition ?? 0) - (b.thread?.pinPosition ?? 0));
  const inboxes = visibleInboxes.filter(({ thread }) => thread?.pinPosition === undefined);
  const pinnedGroups = visibleGroups
    .filter((thread) => thread.pinPosition !== undefined)
    .sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0));
  const groups = visibleGroups.filter((thread) => thread.pinPosition === undefined);
  const bus = sections.bus.filter((thread) => matches(threadText(thread)));
  const shown =
    inboxes.length + groups.length + pinnedInboxes.length + pinnedGroups.length + bus.length;

  const setPinned = async (thread: ThreadSummary, pinned: boolean) => {
    if (pinning.has(thread.id)) return;
    setPinning((current) => new Set(current).add(thread.id));
    setPinError(undefined);
    try {
      if (pinned) await api.pinThread(thread.id);
      else await api.unpinThread(thread.id);
      props.onPinsChanged?.();
    } catch (err) {
      setPinError(errorMessage(err));
    } finally {
      setPinning((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const pinMenu = (thread: ThreadSummary, title: string) => (
    <ActionMenu
      className="thread-row-menu"
      label={t("threadRail.pin.more", { title })}
      disabled={pinning.has(thread.id)}
      items={[
        {
          id: thread.pinPosition === undefined ? "pin" : "unpin",
          label:
            thread.pinPosition === undefined ? t("threadRail.pin.pin") : t("threadRail.pin.unpin"),
          onAction: () => void setPinned(thread, thread.pinPosition === undefined),
        },
      ]}
    />
  );

  const subtitle = (thread: ThreadSummary, group: boolean, names: readonly string[]) => {
    const last = thread.lastMessage;
    const incoming =
      thread.lastHandoff && (!last || thread.lastHandoff.createdAt >= last.ts)
        ? thread.lastHandoff
        : undefined;
    const lastAuthor =
      last?.authorKind === "bot"
        ? (botName(last.authorId as BotId) ?? t("threadRail.lastAuthor.bot"))
        : last?.authorKind === "human"
          ? t("threadRail.lastAuthor.you")
          : last?.authorKind === "system"
            ? t("threadRail.lastAuthor.system")
            : undefined;
    return (
      <span className="thread-sub muted small">
        {incoming ? (
          <span className="thread-preview">
            {incoming.callerName}: {incoming.excerpt}
          </span>
        ) : last ? (
          <span className="thread-preview">
            {group && lastAuthor ? <strong>{lastAuthor}: </strong> : null}
            {last.excerpt}
          </span>
        ) : group ? (
          <span className="thread-preview">{names.join(", ")}</span>
        ) : (
          <span className="thread-preview">{t("threadRail.row.noMessages")}</span>
        )}
        {thread.status === "paused" ? (
          <Pill tone="warning">{t("threadRail.row.paused")}</Pill>
        ) : null}
      </span>
    );
  };

  // Name first, then the authoritative unread count, then the time in a slot that never shrinks.
  const titleLine = (title: string, thread: ThreadSummary) => (
    <span className="thread-title">
      <span>{title}</span>
      {(thread.unreadHandoffs ?? 0) > 0 ? (
        <span
          className="handoff-unread"
          aria-label={t("threadRail.row.unreadHandoffs", { count: thread.unreadHandoffs })}
        >
          {thread.unreadHandoffs}
        </span>
      ) : null}
      <span className="thread-time">{formatRelative(thread.updatedAt)}</span>
    </span>
  );

  const row = (thread: ThreadSummary, pinnable = true) => {
    const ids = memberIdsOf(thread);
    const names = ids.map((id) => botName(id) ?? id);
    const group = ids.length > 1;
    return (
      <li key={thread.id} className={thread.id === selectedId ? "selected" : ""}>
        <div className="thread-row-shell">
          <a href={threadHref(thread.id)}>
            <span className="thread-avatars">
              {group ? (
                <AvatarStack names={names} />
              ) : ids.length === 1 ? (
                <Avatar name={names[0] ?? "?"} />
              ) : (
                <span className="avatar" aria-hidden="true">
                  <BotIcon size={14} />
                </span>
              )}
            </span>
            {titleLine(chatTitle(thread, botName), thread)}
            {subtitle(thread, group, names)}
          </a>
          {pinnable && thread.kind === "chat" ? pinMenu(thread, chatTitle(thread, botName)) : null}
        </div>
      </li>
    );
  };

  const inboxRow = ({ bot, thread, earlier }: InboxEntry) => {
    if (thread) {
      const title = thread.privateChatBotId === bot.id ? bot.name : chatTitle(thread, botName);
      return (
        <li key={thread.id} className={thread.id === selectedId ? "selected" : ""}>
          <div className="thread-row-shell">
            <a href={threadHref(thread.id)}>
              <span className="thread-avatars">
                <Avatar name={bot.name} avatar={bot.avatar} />
              </span>
              {titleLine(title, thread)}
              {subtitle(thread, false, [bot.name])}
            </a>
            {pinMenu(thread, title)}
          </div>
          {earlier.length > 0 ? (
            <details className="earlier-chats" open>
              <summary>{t("threadRail.otherConversations", { count: earlier.length })}</summary>
              <ul className="thread-list">{earlier.map((item) => row(item, false))}</ul>
            </details>
          ) : null}
        </li>
      );
    }
    // Unopened: drawn from the bot row alone, with no time, unread count or activity to show.
    const busy = opening.has(bot.id);
    const error = failed.get(bot.id);
    return (
      <li key={`bot:${bot.id}`}>
        <button
          type="button"
          className="thread-row"
          aria-label={t("threadRail.inbox.openLabel", { name: bot.name })}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void openInbox(bot)}
        >
          <span className="thread-avatars">
            <Avatar name={bot.name} avatar={bot.avatar} />
          </span>
          <span className="thread-title">
            <span>{bot.name}</span>
          </span>
          <span className="thread-sub muted small">
            <span className="thread-preview">
              {busy ? t("threadRail.inbox.opening") : bot.role || t("threadRail.row.noMessages")}
            </span>
          </span>
        </button>
        {error ? (
          <p className="thread-row-error error small" role="alert">
            <span>{t("threadRail.inbox.failed", { error })}</span>
            <button type="button" className="link-button" onClick={() => void openInbox(bot)}>
              {t("threadRail.inbox.retry")}
            </button>
          </p>
        ) : null}
      </li>
    );
  };

  const mixedRows = (entries: InboxEntry[], chats: ThreadSummary[], pinned = false) =>
    [
      ...entries.map((entry) => ({ thread: entry.thread, entry })),
      ...chats.map((thread) => ({ thread, entry: undefined })),
    ]
      .sort((a, b) =>
        pinned
          ? (a.thread?.pinPosition ?? 0) - (b.thread?.pinPosition ?? 0)
          : (b.thread?.updatedAt ?? "").localeCompare(a.thread?.updatedAt ?? ""),
      )
      .map(({ thread, entry }) => (entry ? inboxRow(entry) : thread ? row(thread) : null));

  return (
    <aside className="rail">
      <div className="rail-heading">
        <h2>{t("threadRail.heading")}</h2>
        {/* The dialog creates groups and bots, which are an Admin's (ADR-0022 amendment 7 S6). */}
        {workspace && canCreateSomething ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t("threadRail.newChat")}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={18} />
          </button>
        ) : null}
      </div>
      {workspace && !nothing ? (
        <div className="rail-search">
          <Search size={15} />
          <input
            type="search"
            aria-label={t("threadRail.search.label")}
            placeholder={t("threadRail.search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      <div className="rail-scroll">
        {pinError ? <p className="error small thread-row-error">{pinError}</p> : null}
        {!workspace ? (
          <div className="thread-empty">
            <p className="muted">{t("threadRail.empty.noWorkspace")}</p>
            {canCreateWorkspace.allowed ? (
              <NextAction
                action="workspace.create"
                does={t("threadRail.empty.createWorkspaceFull")}
                how={t("threadRail.empty.createWorkspaceFullHow")}
              />
            ) : (
              <NextAction action="workspace.create" does={t("threadRail.empty.createWorkspace")} />
            )}
          </div>
        ) : nothing ? (
          <div className="thread-empty">
            <p className="muted">{t("threadRail.empty.noChats")}</p>
            <NextAction
              action="sideChat.open"
              does={t("threadRail.empty.startChat")}
              how={t("threadRail.empty.startChatHow")}
            />
          </div>
        ) : shown === 0 ? (
          <p className="thread-empty muted">{t("threadRail.empty.noMatch", { query })}</p>
        ) : null}
        {pinnedInboxes.length + pinnedGroups.length > 0 ? (
          <details className="rail-section pinned-chats" open>
            <summary>
              {t("threadRail.section.pinned")}{" "}
              <span className="muted">({pinnedInboxes.length + pinnedGroups.length})</span>
            </summary>
            <ul className="thread-list">{mixedRows(pinnedInboxes, pinnedGroups, true)}</ul>
          </details>
        ) : null}
        <ul className="thread-list">{mixedRows(inboxes, groups)}</ul>
        {bus.length > 0 ? (
          <details
            className="rail-section"
            open={inboxes.length + groups.length + pinnedInboxes.length + pinnedGroups.length === 0}
          >
            <summary>
              <Users size={14} /> {t("threadRail.botsTalking")}{" "}
              <span className="muted">({bus.length})</span>
            </summary>
            <ul className="thread-list">{bus.map((item) => row(item, false))}</ul>
          </details>
        ) : null}
        {props.more ? (
          <button
            type="button"
            className="link-button rail-more"
            disabled={props.more.loading}
            onClick={props.more.onLoad}
          >
            {props.more.loading ? t("threadRail.loadingMore") : t("threadRail.loadMore")}
          </button>
        ) : null}
      </div>
      {!workspace ? (
        // A Member's form would only be refused; the line above says who can create one.
        canCreateWorkspace.allowed ? (
          <div className="rail-create">
            <FirstRunForm api={api} onCreated={props.onCreated} />
          </div>
        ) : null
      ) : (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-w-md" closeLabel={t("threadRail.dialog.close")}>
            <DialogTitle className="pr-8 text-lg font-semibold">
              {t("threadRail.dialog.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {t("threadRail.dialog.description")}
            </DialogDescription>
            <NewThreadForm
              api={api}
              workspace={workspace}
              bots={bots}
              onCreated={(created) => {
                setCreateOpen(false);
                props.onCreated(created);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </aside>
  );
}

interface NewThreadFormProps {
  api: ApiClient;
  workspace: Workspace;
  bots: readonly BotDefinition[];
  onCreated: ThreadRailProps["onCreated"];
}

function NewThreadForm({ api, workspace, bots, onCreated }: NewThreadFormProps) {
  const t = useT();
  const workspaceId = workspace.id;
  const wsBots = bots.filter((b) => b.workspaceId === workspaceId);
  const [botIds, setBotIds] = useState<readonly BotId[]>(() => wsBots.slice(0, 2).map((b) => b.id));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const canCreateBot = useCan("bot.create");
  const canCreateGroup = useCan("thread.create");

  const toggleBot = (botId: BotId, checked: boolean) => {
    setBotIds((selected) => {
      if (!checked) return selected.filter((id) => id !== botId);
      if (selected.includes(botId) || selected.length >= CHAT_THREAD_MAX_MEMBERS) return selected;
      return [...selected, botId];
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = title.trim();
      const { thread } = await api.createThread({
        workspaceId,
        botIds: [...botIds],
        ...(trimmed ? { title: trimmed } : {}),
      });
      setTitle("");
      onCreated({ thread });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} aria-label={t("threadRail.newThread.formLabel")}>
      {wsBots.length >= 2 ? (
        <fieldset className="bot-picker">
          <legend>
            {t("threadRail.newThread.botsIn", {
              workspace: workspace.name,
              max: CHAT_THREAD_MAX_MEMBERS,
            })}
          </legend>
          {wsBots.map((b) => {
            const checked = botIds.includes(b.id);
            const atLimit = botIds.length >= CHAT_THREAD_MAX_MEMBERS;
            return (
              <label key={b.id} className="contact-option">
                <input
                  type="checkbox"
                  name="thread-bot"
                  value={b.id}
                  checked={checked}
                  disabled={!checked && atLimit}
                  onChange={(e) => toggleBot(b.id, e.target.checked)}
                />
                <Avatar name={b.name} size="sm" />
                <span>
                  {b.name}
                  {b.role ? <span className="muted"> · {b.role}</span> : null}
                </span>
              </label>
            );
          })}
          <span className="muted small">
            <span>
              {t("threadRail.newThread.selected", {
                count: botIds.length,
                max: CHAT_THREAD_MAX_MEMBERS,
              })}
            </span>
            <span>
              {botIds.length >= 2
                ? t("threadRail.newThread.groupChat")
                : t("threadRail.newThread.minimum")}
            </span>
          </span>
        </fieldset>
      ) : (
        <p className="muted small">{t("threadRail.newThread.needTwo")}</p>
      )}
      <label>
        {t("threadRail.newThread.titleLabel")}
        <input
          value={title}
          placeholder={t("threadRail.newThread.titlePlaceholderGroup")}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {error ? <p className="error small">{error}</p> : null}
      <Button
        type="submit"
        variant="default"
        disabled={busy || !workspaceId || !canCreateGroup.allowed || botIds.length < 2}
      >
        {t("threadRail.newThread.submit")}
      </Button>
      {canCreateBot.allowed ? (
        <a className="button secondary" href={newContactHref()}>
          {t("threadRail.newThread.newBot")}
        </a>
      ) : (
        <NextAction action="bot.create" does={t("threadRail.newThread.addBot")} />
      )}
    </form>
  );
}

interface FirstRunFormProps {
  api: ApiClient;
  onCreated: ThreadRailProps["onCreated"];
}

function FirstRunForm({ api, onCreated }: FirstRunFormProps) {
  const t = useT();
  const [workspaceName, setWorkspaceName] = useState("default");
  const [locked, setLocked] = useState(false);
  const [allowlist, setAllowlist] = useState("");
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await api.createWorkspace({
        name: workspaceName.trim(),
        egressAllowlist: locked ? splitList(allowlist) : [EGRESS_OPEN_INTERNET],
      });
      const bot = await api.createBot({
        name: botName.trim(),
        role: botRole.trim(),
        workspaceId: workspace.id,
      });
      const { thread } = await api.resolvePrivateChat(bot.id);
      onCreated({ thread, workspace, bot });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} aria-label={t("threadRail.firstRun.formLabel")}>
      <h3>{t("threadRail.firstRun.heading")}</h3>
      <p className="muted small">{t("threadRail.firstRun.intro")}</p>
      <label>
        {t("threadRail.firstRun.workspaceName")}
        <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required />
      </label>
      <EgressModePicker
        locked={locked}
        domains={allowlist}
        onLocked={setLocked}
        onDomains={setAllowlist}
      />
      <label>
        {t("threadRail.firstRun.botName")}
        <input
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
          pattern="[A-Za-z0-9_\-]+"
          required
        />
      </label>
      <label>
        {t("threadRail.firstRun.botRole")}
        <input value={botRole} onChange={(e) => setBotRole(e.target.value)} />
      </label>
      {error ? <p className="error small">{error}</p> : null}
      <Button type="submit" variant="default" disabled={busy}>
        {t("threadRail.firstRun.submit")}
      </Button>
    </form>
  );
}
