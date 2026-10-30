import { ResizeHandle } from "@deskmates/ui";
import type { CSSProperties } from "react";
import { Button } from "../../components/ui/button.js";
import { usePanelWidth } from "../../state/panel-width.js";
// Conversation screen: the rail of conversations on the left, one transcript on the right and,
// when the operator wants it, the members' desktops in a third column.

import type {
  BotDefinition,
  BotId,
  Thread,
  ThreadId,
  ThreadSummary,
  Workspace,
} from "@deskmates/contracts";
import { DEFAULT_BOT_NAME } from "@deskmates/contracts";
import { ArrowUpRight, Bot, MessageSquare, Monitor } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import type { NamedThreadMember } from "../../api/types.js";
import { type FirstRunAssistant, FirstRunChecklist } from "../../app/first-run-checklist.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { contactHref, navigate, threadHref } from "../../router.js";
import { useRememberBots } from "../../state/bot-avatars.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { ChatPane } from "./chat-pane.js";
import { threadsHref } from "./route.js";
import { ThreadRail } from "./thread-rail.js";

export interface ThreadScreenProps {
  threadId?: ThreadId | undefined;
  messageId?: string | undefined;
  api?: ApiClient;
}

const INFO_KEY = "deskmates.showChatInfo";

function loadShowInfo(): boolean {
  try {
    return window.localStorage.getItem(INFO_KEY) === "1";
  } catch {
    return false;
  }
}

export function ThreadScreen(props: ThreadScreenProps) {
  const { threadId } = props;
  const frame = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth - 68);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const railWidth = usePanelWidth("chats", 260, 220, () => Math.min(460, availableWidth - 320));
  const api = props.api ?? defaultApi;
  const t = useT();
  const scope = useWorkspaceScope(api);
  const rememberBots = useRememberBots();
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);
  const [threads, setThreads] = useState<readonly ThreadSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showInfo, setShowInfo] = useState(loadShowInfo);
  const reloadRevision = useRef(0);
  // #113 slice CH: the rail reads the current workspace's first page (pins, inboxes and the
  // newest conversations); older pages load on request and survive a refresh of the first.
  const railWorkspaceId = scope.current?.id;
  const scopeLoaded = scope.loaded;
  const [railCursor, setRailCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const olderIds = useRef(new Set<string>());
  const selectedRef = useRef(threadId);
  selectedRef.current = threadId;

  const reload = useCallback(async () => {
    const revision = ++reloadRevision.current;
    setReloading(true);
    try {
      const [b, page] = await Promise.all([
        api.listBots(),
        railWorkspaceId ? api.listThreadPage(railWorkspaceId) : Promise.resolve(undefined),
      ]);
      if (revision !== reloadRevision.current) return;
      setBots(b);
      rememberBots(b);
      if (page && railWorkspaceId) {
        const first = new Set(page.threads.map((thread) => thread.id as string));
        // Other workspaces' rows stay (an open chat elsewhere must still be recognised), as do
        // this workspace's older pages and the open chat; the first page replaces the rest.
        setThreads((prev) =>
          [
            ...page.threads,
            ...prev.filter(
              (thread) =>
                !first.has(thread.id) &&
                (thread.workspaceId !== railWorkspaceId ||
                  olderIds.current.has(thread.id) ||
                  thread.id === selectedRef.current),
            ),
          ].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)),
        );
        if (olderIds.current.size === 0) setRailCursor(page.nextCursor);
      }
      setError(undefined);
      if (page || scopeLoaded) setLoaded(true);
    } catch (err) {
      if (revision === reloadRevision.current) setError(errorMessage(err));
    } finally {
      if (revision === reloadRevision.current) setReloading(false);
    }
  }, [api, rememberBots, railWorkspaceId, scopeLoaded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new workspace starts on page one
  useEffect(() => {
    olderIds.current = new Set();
    setRailCursor(undefined);
  }, [railWorkspaceId]);

  // Search hits beyond the loaded pages join them, so they stay listed like a loaded page.
  const onSearchResults = useCallback((found: readonly ThreadSummary[]) => {
    for (const thread of found) olderIds.current.add(thread.id);
    setThreads((prev) =>
      [...prev.filter((x) => !found.some((y) => y.id === x.id)), ...found].sort((x, y) =>
        y.updatedAt.localeCompare(x.updatedAt),
      ),
    );
  }, []);

  const loadMore = async () => {
    if (!railCursor || !railWorkspaceId || loadingMore) return;
    const revision = reloadRevision.current;
    setLoadingMore(true);
    try {
      const page = await api.listThreadPage(railWorkspaceId, { cursor: railCursor });
      if (revision !== reloadRevision.current && olderIds.current.size === 0) return;
      for (const thread of page.threads) olderIds.current.add(thread.id);
      setThreads((prev) =>
        [...prev.filter((x) => !page.threads.some((y) => y.id === x.id)), ...page.threads].sort(
          (x, y) => y.updatedAt.localeCompare(x.updatedAt),
        ),
      );
      setRailCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const retry = useCallback(() => {
    void reload();
    void scope.reload();
  }, [reload, scope.reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: another API is another Gateway
  useEffect(() => {
    setLoaded(false);
    setBots([]);
    setThreads([]);
    setError(undefined);
  }, [api]);

  useEffect(() => {
    void reload();
    // A pooled SSE stream can remain open while HTTP reads fail. Browser connectivity is an
    // independent recovery signal; retry only reads and keep the authenticated API/drafts.
    const online = () => void reload();
    window.addEventListener("online", online);
    const stop = subscribeEvents({
      onEvent: (event) => {
        if (
          event.type === "thread_activity" ||
          event.type === "thread_message" ||
          event.type === "thread_members" ||
          event.type === "thread_pins"
        )
          void reload();
      },
      onReconnect: () => {
        void reload();
      },
    });
    return () => {
      window.removeEventListener("online", online);
      reloadRevision.current += 1;
      stop();
    };
  }, [reload]);

  // The rail shows the current workspace's chats. A link to a chat in another workspace
  // switches to that workspace rather than opening a chat the rail does not list. When the
  // same chat stays open and the operator picks another workspace, the chat yields instead:
  // the screen leaves it for the new workspace's chat list (#106). Its draft stays in the
  // scoped draft store.
  const workspace = scope.current;
  const opened = threadId ? threads.find((thread) => thread.id === threadId) : undefined;
  const { select } = scope;
  const followed = useRef<{ threadId: ThreadId; workspaceId: string } | undefined>(undefined);
  useEffect(() => {
    if (!opened || !workspace) return;
    const previous = followed.current;
    followed.current = { threadId: opened.id, workspaceId: workspace.id };
    if (opened.workspaceId === workspace.id) return;
    const workspaceChanged =
      previous?.threadId === opened.id && previous.workspaceId !== workspace.id;
    if (workspaceChanged) navigate(threadsHref());
    else select(opened.workspaceId);
  }, [opened, workspace, select]);
  const scopedThreads = workspace
    ? threads.filter((thread) => thread.workspaceId === workspace.id)
    : threads;
  const scopedBots = workspace ? bots.filter((b) => b.workspaceId === workspace.id) : bots;

  const onCreated = ({
    thread,
    workspace: createdWorkspace,
    bot,
  }: {
    thread: Thread;
    workspace?: Workspace;
    bot?: BotDefinition;
  }) => {
    if (createdWorkspace) scope.add(createdWorkspace);
    if (bot) setBots((prev) => [...prev, bot]);
    // A list refresh may already have added this chat, so replace rather than add a second row
    // with the same key: React keeps such a duplicate around stale ("No messages yet") even
    // after later lists carry the chat's preview.
    setThreads((prev) => {
      const existing = prev.find((candidate) => candidate.id === thread.id);
      const row: ThreadSummary = {
        ...existing,
        ...thread,
        memberIds: existing?.memberIds ?? (bot ? [bot.id] : []),
      };
      return [row, ...prev.filter((candidate) => candidate.id !== thread.id)];
    });
    // A refresh still in flight may have been answered before this chat existed; supersede it
    // with one asked now, so its answer cannot drop the new row.
    void reload();
    navigate(threadHref(thread.id));
  };

  // A clicked inbox resolved to the bot's canonical chat (ADR-0024 decision 6). List it under the
  // bot at once with the Gateway's mark; the refresh asked now supersedes any older answer.
  const onPrivateChat = ({ thread, botId }: { thread: Thread; botId: BotId }) => {
    setThreads((prev) => {
      const existing = prev.find((candidate) => candidate.id === thread.id);
      const row: ThreadSummary = {
        ...existing,
        ...thread,
        memberIds: existing?.memberIds ?? [botId],
        privateChatBotId: botId,
      };
      return [
        row,
        ...prev
          .filter((candidate) => candidate.id !== thread.id)
          .map((candidate) => {
            if (candidate.privateChatBotId !== botId) return candidate;
            const { privateChatBotId: _previous, ...rest } = candidate;
            return rest;
          }),
      ].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    });
    void reload();
  };

  // The chat reports its detail (thread row and members) as it loads and changes; the rail
  // merges it so a just-created chat shows its members without another list request.
  // An open chat beyond the loaded rail pages (an old link, another workspace) is added, so the
  // rail and the workspace follow it as before (#113 slice CH).
  const onThreadUpdated = (thread: Thread, members?: readonly NamedThreadMember[]) => {
    setThreads((prev) => {
      const known = prev.some((candidate) => candidate.id === thread.id);
      const rows = known
        ? prev.map((candidate) =>
            candidate.id === thread.id
              ? {
                  ...candidate,
                  ...thread,
                  memberIds: members ? members.map((m) => m.botId) : candidate.memberIds,
                }
              : candidate,
          )
        : [...prev, { ...thread, memberIds: members ? members.map((m) => m.botId) : [] }];
      return rows.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    });
  };

  const toggleInfo = () => {
    setShowInfo((shown) => {
      try {
        window.localStorage.setItem(INFO_KEY, shown ? "0" : "1");
      } catch {
        // A browser without storage still toggles for this page load.
      }
      return !shown;
    });
  };

  const loadError = error ?? scope.error;
  const ready = loaded && scope.loaded;

  return (
    <div
      ref={frame}
      className={`thread-screen${threadId ? " has-thread" : ""}${loadError ? " has-load-error" : ""}`}
      style={{ "--rail-w": `${railWidth.width}px` } as CSSProperties}
    >
      {loadError ? (
        <div className="thread-load-error" role="alert">
          <span>{t("thread.loadError", { error: loadError })}</span>
          <Button size="sm" onClick={retry} disabled={reloading}>
            {t("thread.retry")}
          </Button>
        </div>
      ) : null}
      <div className="thread-rail-panel">
        {ready ? (
          <ThreadRail
            workspace={workspace}
            bots={scopedBots}
            threads={scopedThreads}
            selectedId={threadId}
            onCreated={onCreated}
            onPrivateChat={onPrivateChat}
            onPinsChanged={() => void reload()}
            more={railCursor ? { loading: loadingMore, onLoad: () => void loadMore() } : undefined}
            onSearchResults={onSearchResults}
            api={api}
          />
        ) : (
          <aside className="rail">
            <p className="thread-empty muted">
              {loadError ? t("thread.unavailable") : t("thread.loading")}
            </p>
          </aside>
        )}
        <ResizeHandle
          label={t("panel.resizeChats")}
          value={railWidth.width}
          min={railWidth.min}
          max={railWidth.max}
          onChange={railWidth.setWidth}
        />
      </div>
      {!ready ? (
        <section className="chat empty">
          <p className="muted">{loadError ? t("thread.unavailable") : t("thread.loading")}</p>
        </section>
      ) : threadId ? (
        <ChatPane
          key={threadId}
          threadId={threadId}
          messageId={props.messageId}
          api={api}
          bots={bots}
          onThreadUpdated={onThreadUpdated}
          infoShown={showInfo}
          onToggleInfo={toggleInfo}
          pinned={opened?.pinPosition !== undefined}
          onPinsChanged={() => void reload()}
        />
      ) : (
        <section className="chat empty">
          <div className="welcome-state">
            <span className="welcome-icon">
              <Bot size={34} />
            </span>
            <span className="eyebrow">{t("thread.welcome.eyebrow")}</span>
            <h1>
              {workspace
                ? t("thread.welcome.titleWorkspace", { workspace: workspace.name })
                : t("thread.welcome.titleNone")}
            </h1>
            <p>
              {t("thread.welcome.pick")}
              <br />
              {t("thread.welcome.control")}
            </p>
            <div className="welcome-features">
              <span>
                <MessageSquare size={18} /> {t("thread.welcome.collaborate")}
              </span>
              <span>
                <Monitor size={18} /> {t("thread.welcome.follow")}
              </span>
            </div>
            <a className="welcome-link" href="#/contacts">
              {t("thread.welcome.meetBots")} <ArrowUpRight size={16} />
            </a>
            {ready ? (
              <FirstRunChecklist
                workspaces={scope.workspaces.length}
                bots={bots.length}
                threads={threads.length}
                assistant={assistantOf(workspace, scopedBots, scopedThreads)}
              />
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The workspace's default bot and its private chat, for the first-run checklist (ADR-0051).
 * Before any workspace exists, the one the first-run form creates comes with `assistant`.
 */
function assistantOf(
  workspace: Workspace | undefined,
  bots: readonly BotDefinition[],
  threads: readonly ThreadSummary[],
): FirstRunAssistant | undefined {
  if (!workspace) return { name: DEFAULT_BOT_NAME, href: threadsHref() };
  const bot = bots.find((item) => item.id === workspace.defaultBotId);
  if (!bot) return undefined;
  const chat = threads.find((thread) => thread.privateChatBotId === bot.id);
  return { name: bot.name, href: chat ? threadHref(chat.id) : contactHref(bot.id) };
}
