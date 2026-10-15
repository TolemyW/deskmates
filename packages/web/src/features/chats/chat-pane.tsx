import { ChatViewport } from "@deskmates/ui";
import { ArrowLeft, ArrowUp, Info, PauseCircle } from "lucide-react";
import { Avatar, AvatarStack } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Markdown, looksLikeMarkdown } from "../../lib/markdown.js";
import { approvalEchoLabel } from "../../state/actor-label.js";
import { useActorLabel } from "../../state/session-roles.js";
import { DesktopView } from "../computer/desktop-view.js";
import { AttachmentCards } from "./attachment-cards.js";
import { ChatInfo } from "./chat-info.js";
import { ChatRunStop } from "./chat-run-stop.js";
import {
  ComposerAttachButton,
  ComposerAttachmentChips,
  onComposerPaste,
  useChatDropTarget,
  useComposerAttachments,
} from "./composer-attachments.js";
import { IncomingHandoffs } from "./incoming-handoffs.js";
import { PrivateChatActivity } from "./private-chat-activity.js";
import {
  RoundModeToggle,
  RoundStrip,
  currentRound,
  mentionsEveryone,
  useThreadRounds,
} from "./round-strip.js";
import { namesTitle } from "./thread-rail.js";
// Main pane of the thread screen: transcript, typing indicator and composer for one thread.
// The transcript is loaded from the API and then appended live from the SSE stream.

import {
  type Approval,
  type BotDefinition,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type WorkspaceId,
  isChannelMirrorThread,
  isPastDeadline,
  isTerminal,
  isThreadLinkAttachmentMime,
  isWelcomeGreeting,
  welcomeDelivery,
} from "@deskmates/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { type ConnectionStatus, subscribeEvents } from "../../api/events.js";
import type { NamedThreadMember, RunView, ThreadDetailView } from "../../api/types.js";
import { errorMessage, formatDateTime, formatDay, formatTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { runHref, threadHref } from "../../router.js";
import {
  authorizeConversationDraft,
  beginConversationSubmission,
  completeConversationSubmission,
  dismissFailedConversationSubmission,
  failConversationSubmission,
  readConversationComposer,
  restoreFailedConversationSubmission,
  subscribeConversationComposer,
  writeConversationDraft,
} from "../../state/conversation-drafts.js";
import { RoleNote, useCanPost, useIsGuest } from "../../state/session-roles.js";
import {
  EMPTY_THREAD_VIEW,
  activeRuns,
  latestRunForBot,
  runStatusLabel,
  threadViewReducer,
  transcriptTimeline,
} from "../../state/thread-view.js";
import { ApprovalCard, approvalRefOf } from "../approvals/approval-card.js";
import { ApproveAllBadge } from "../approvals/approval-mode.js";
import { splitWorkspacePaths } from "../files/path-links.js";
import { ActivityPanel } from "../runs/activity.js";
import { firstRunPages } from "../runs/run-feed.js";
import { MentionTextarea } from "./mention-textarea.js";
import { ThreadMembership } from "./thread-membership.js";

const CONNECTION_LABELS: Readonly<Record<ConnectionStatus, MessageKey>> = {
  open: "chatPane.connection.open",
  connecting: "chatPane.connection.connecting",
  reconnecting: "chatPane.connection.reconnecting",
};

/** The Gateway's cap on approval ids per request (#113 surface 26). */
const APPROVAL_IDS_PER_REQUEST = 100;

/** The approval ids the messages name, distinct, in batches the Gateway accepts. */
function approvalIdBatches(messages: readonly ThreadMessage[]): string[][] {
  const ids = [
    ...new Set(
      messages.map((m) => approvalRefOf(m.attachments)).filter((ref) => ref !== undefined),
    ),
  ];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += APPROVAL_IDS_PER_REQUEST)
    batches.push(ids.slice(i, i + APPROVAL_IDS_PER_REQUEST));
  return batches;
}

/** One line for the header: who is in the chat and what is happening right now. */
function membersSummary(
  members: readonly { botId: string; name: string }[],
  activity: ReadonlyMap<string, string>,
): string {
  const { t } = currentI18n();
  const ready = t("chatPane.activity.ready");
  const busy = members.filter((m) => {
    const state = activity.get(m.botId) ?? ready;
    return state !== ready;
  });
  const who =
    members.length === 1
      ? (members[0]?.name ?? "")
      : t("chatPane.summary.bots", { count: members.length });
  if (busy.length === 0) return t("chatPane.summary.line", { who, activity: ready });
  return t("chatPane.summary.line", {
    who,
    activity: busy
      .map((m) =>
        t("chatPane.summary.busyMember", { name: m.name, activity: activity.get(m.botId) }),
      )
      .join(", "),
  });
}
import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";
import { ReplyPreviews, replyPreviewReducer } from "./reply-preview.js";
import { type WorkspaceLockState, useWorkspaceLock } from "./use-workspace-lock.js";
import { VisionNotice } from "./vision-notice.js";

export interface ChatPaneProps {
  threadId: ThreadId;
  messageId?: string | undefined;
  api?: ApiClient;
  bots?: readonly BotDefinition[];
  onThreadUpdated?: (thread: Thread, members?: readonly NamedThreadMember[]) => void;
  /** Whether the chat info column is shown; undefined hides the toggle (standalone use). */
  infoShown?: boolean;
  onToggleInfo?: () => void;
  /** Workspace-shared display preference; it never changes routing. */
  pinned?: boolean;
  onPinsChanged?: () => void;
}

export function ChatPane(props: ChatPaneProps) {
  const { threadId } = props;
  const api = props.api ?? defaultApi;
  const t = useT();
  const actorName = useActorLabel();
  const [state, dispatch] = useReducer(threadViewReducer, EMPTY_THREAD_VIEW);
  const [previews, applyPreview] = useReducer(replyPreviewReducer, {});
  const [detail, setDetail] = useState<ThreadDetailView | undefined>();
  const members = detail?.members ?? [];
  // Only `owner-v1` offers an unaddressed message to the owner first; under the walk (or an older
  // Gateway that does not report routing) an owner mark would promise something that is not so.
  const ownerBotId =
    detail?.groupRouting === "owner-v1" && members.length > 1
      ? detail.thread.ownerBotId
      : undefined;
  const knownNamesRef = useRef(new Map<string, string>());
  for (const member of members) knownNamesRef.current.set(member.botId, member.name);
  // Declared before the transcript subscription so its unfiltered stream opens first.
  const browser = useWorkspaceLock(detail?.thread.workspaceId, api);
  // A Member posts in shared chats, never a bus thread; a Guest nowhere (ADR-0022 amendment 6).
  const canPost = useCanPost(detail?.thread, members.length);
  // A Guest reads the transcript only: runs and approvals are refused to them (amendment 6 W6).
  const guest = useIsGuest(detail?.thread.workspaceId);
  const guestRef = useRef(guest);
  guestRef.current = guest;
  // A thread owned by an external chat channel is a read-only mirror: its human converses on that
  // channel, and the Gateway refuses a Web post to it (ADR-0017 amendment 2).
  const mirrorChannel =
    detail !== undefined && isChannelMirrorThread(detail.thread)
      ? detail.thread.channel
      : undefined;
  const channelName = useChannelDisplayName(api, mirrorChannel);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  const [retryingWelcome, setRetryingWelcome] = useState(false);
  const [handoffRuns, setHandoffRuns] = useState<readonly string[]>([]);
  const [botRuns, setBotRuns] = useState<readonly RunView[]>([]);
  const [runsCursor, setRunsCursor] = useState<string>();
  // #113 slice CH: the transcript opens on its newest messages; older ones load on request.
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  // ADR-0005 amendment 4, decision 29: the mode of the next @everyone message only.
  const [roundMode, setRoundMode] = useState<"parallel" | "sequential">("parallel");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread starts in parallel
  useEffect(() => setRoundMode("parallel"), [threadId]);
  const subscribeComposer = useCallback(
    (listener: () => void) => subscribeConversationComposer(api, threadId, listener),
    [api, threadId],
  );
  const readComposer = useCallback(() => readConversationComposer(api, threadId), [api, threadId]);
  const composer = useSyncExternalStore(subscribeComposer, readComposer, readComposer);
  const draft = composer.draft;
  const sendBlocked = composer.pending !== undefined || composer.failed !== undefined;
  // ADR-0014 A5 decisions 41 and 42: files attached by paperclip, drop or paste wait as chips.
  const composerFiles = useComposerAttachments(api, detail?.thread.workspaceId, threadId);
  // A Guest never uploads, and a channel mirror takes no Web post (the Gateway refuses both).
  const attachAllowed =
    canPost.allowed &&
    !guest &&
    mirrorChannel === undefined &&
    detail?.thread.workspaceId !== undefined;
  const dropTarget = useChatDropTarget(composerFiles, attachAllowed);
  // The subscription callbacks outlive a render, so the refetch reads the transcript from a ref.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Kept outside React state so a fetch records its starting revision even when updates are batched.
  const runRevisionRef = useRef(0);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const onThreadUpdatedRef = useRef(props.onThreadUpdated);
  onThreadUpdatedRef.current = props.onThreadUpdated;
  const refreshDetailRef = useRef<() => Promise<void>>(async () => {});
  const approvalsForRef = useRef<(messages: readonly ThreadMessage[]) => Promise<Approval[]>>(
    async () => [],
  );
  const lifecycleRevisionRef = useRef(0);

  useEffect(() => {
    const lifecycleRevision = lifecycleRevisionRef.current + 1;
    lifecycleRevisionRef.current = lifecycleRevision;
    let cancelled = false;
    let detailRequest = 0;
    setError(undefined);
    dispatch({ type: "reset" });
    applyPreview({ type: "reset" });
    setRunsCursor(undefined);
    setHasOlderMessages(false);
    runRevisionRef.current = 0;
    setDetail(undefined);

    /** Apply only the newest requested detail snapshot; an older slow response is stale. */
    const refreshDetail = async (): Promise<void> => {
      const request = ++detailRequest;
      const next = await api.getThread(threadId);
      if (cancelled || request !== detailRequest) return;
      authorizeConversationDraft(api, threadId, next.thread.workspaceId);
      setDetail(next);
      onThreadUpdatedRef.current?.(next.thread, next.members);
    };
    refreshDetailRef.current = refreshDetail;

    /** Ask for what the stream may not have delivered; the reducer merges it in. */
    // #113 surface 26: the thread's pending approvals (bounded by its parked runs) plus the ones
    // the loaded messages name, never the thread's whole decided history.
    const listApprovals = async (messages: readonly ThreadMessage[]): Promise<Approval[]> => {
      if (guestRef.current) return [];
      const [pending, ...named] = await Promise.all([
        api.listApprovals({ threadId, status: "pending" }),
        ...approvalIdBatches(messages).map((ids) => api.listApprovals({ threadId, ids })),
      ]);
      return [...pending, ...named.flat()];
    };
    approvalsForRef.current = listApprovals;

    // #113 slice R: every unfinished run plus the newest finished page; older pages on request.
    const listRuns = async (): Promise<RunView[]> => {
      if (guestRef.current) return [];
      const page = await firstRunPages(api, { threadId });
      if (!cancelled) setRunsCursor(page.nextCursor);
      return page.runs;
    };

    /** The newest window; whether older messages exist is remembered for Load older. */
    const newestMessages = async () => {
      const slice = await api.listMessageSlice(threadId);
      if (!cancelled) setHasOlderMessages(slice.hasOlder === true);
      return slice.messages;
    };

    /** What the stream missed after `afterSeq`, read as bounded tails until none is left. */
    const tailAfter = async (afterSeq: number) => {
      const messages: ThreadMessage[] = [];
      let after = afterSeq;
      for (let more = true; more && !cancelled; ) {
        const slice = await api.listMessageSlice(threadId, { afterSeq: after });
        messages.push(...slice.messages);
        after = slice.messages.at(-1)?.seq ?? after;
        more = slice.hasMore === true && slice.messages.length > 0;
      }
      return messages;
    };

    const refetch = async (): Promise<void> => {
      const afterSeq = stateRef.current.messages.at(-1)?.seq;
      const runSnapshotRevision = runRevisionRef.current;
      const [{ messages, approvals }, runs] = await Promise.all([
        (afterSeq === undefined ? newestMessages() : tailAfter(afterSeq)).then(
          async (messages) => ({
            messages,
            approvals: await listApprovals([...stateRef.current.messages, ...messages]),
          }),
        ),
        listRuns(),
        refreshDetail(),
      ]);
      if (!cancelled) {
        dispatch({ type: "loaded", messages, runs, approvals, runSnapshotRevision });
      }
    };

    const stop = subscribeEvents({
      threadId,
      onEvent: (event) => {
        if (cancelled) return;
        if (event.type === "run_status") runRevisionRef.current += 1;
        dispatch(event);
        applyPreview(event);
        // Messages can add a member or pause/reset the thread; run changes affect each member's
        // activity. Refresh the authoritative detail while the reducer applies the live frame.
        if (
          event.type === "thread_message" ||
          event.type === "thread_members" ||
          event.type === "run_status"
        ) {
          void refreshDetail().catch((err: unknown) => {
            if (!cancelled) setError(errorMessage(err));
          });
        }
      },
      onStatus: (s) => {
        if (!cancelled) setConnection(s);
      },
      // Frames emitted while the stream was down are never replayed, so recover them by hand.
      onReconnect: () => {
        void refetch().catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
      },
    });

    const initialRunSnapshotRevision = runRevisionRef.current;
    const newestWithApprovals = async () => {
      const messages = await newestMessages();
      return { messages, approvals: await listApprovals(messages) };
    };
    Promise.all([refreshDetail(), newestWithApprovals(), listRuns()])
      .then(([, { messages, approvals }, runs]) => {
        if (cancelled) return;
        dispatch({
          type: "loaded",
          messages,
          runs,
          approvals,
          runSnapshotRevision: initialRunSnapshotRevision,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      if (lifecycleRevisionRef.current === lifecycleRevision) lifecycleRevisionRef.current += 1;
      stop();
    };
  }, [threadId, api]);

  useEffect(() => {
    if (!props.messageId || !state.messages.some((message) => message.id === props.messageId))
      return;
    const element = document.getElementById(`message-${props.messageId}`);
    if (element) {
      element.classList.add("message-highlight");
    }
    return () => element?.classList.remove("message-highlight");
  }, [props.messageId, state.messages]);

  const botName = (botId: string): string =>
    members.find((m) => m.botId === botId)?.name ??
    props.bots?.find((bot) => bot.id === botId)?.name ??
    knownNamesRef.current.get(botId) ??
    botId;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.body.trim();
    const attached = composerFiles.ready;
    if (
      (!body && attached.length === 0) ||
      composerFiles.blocked ||
      sendBlocked ||
      mirrorChannel !== undefined
    )
      return;
    const started = beginConversationSubmission(api, threadId, draft.revision);
    const submission = started.pending;
    if (!submission) return;
    const lifecycleRevision = lifecycleRevisionRef.current;
    setError(undefined);
    try {
      const runSnapshotRevision = runRevisionRef.current;
      const sequential = roundMode === "sequential" && mentionsEveryone(body);
      const result = await api.postMessage(
        threadId,
        body,
        undefined,
        sequential ? "sequential" : undefined,
        attached,
      );
      composerFiles.sent(attached);
      setRoundMode("parallel");
      completeConversationSubmission(api, threadId, submission.id);
      if (lifecycleRevisionRef.current !== lifecycleRevision) return;
      // The SSE echo or a later run state may already have arrived while POST was in flight. Treat
      // the response as the snapshot it is, so queued cannot replace a live running update.
      dispatch({
        type: "loaded",
        messages: [result.message],
        // A Guest's status job is no run they read (ADR-0022 amendment 7 S4): its answer arrives
        // as a message, and no run event would ever settle it here.
        runs: guestRef.current ? [] : result.runs,
        runSnapshotRevision,
      });
      // A human message resumes a thread paused by its turn budget.
      const current = detailRef.current;
      if (current?.thread.status === "paused") {
        const next = { ...current, thread: { ...current.thread, status: "active" as const } };
        setDetail(next);
        onThreadUpdatedRef.current?.(next.thread);
      }
      void refreshDetailRef.current().catch((err: unknown) => setError(errorMessage(err)));
    } catch (err) {
      const message = errorMessage(err);
      failConversationSubmission(api, threadId, submission.id, message);
    }
  };

  const pending = activeRuns(state);
  const roundRevision = `${state.messages.length}:${pending.map((run) => `${run.id}${run.status}`).join(",")}:${Object.keys(state.runs).length}`;
  const { rounds, reload: reloadRounds } = useThreadRounds(api, threadId, roundRevision);
  const round = currentRound(rounds);
  const latestWelcome = Object.values(state.runs)
    .filter((run) => run.triggerKind === "welcome")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  // ADR-0024 amendment 2, decision 11: a silent welcome that greeted through `thread_post` is
  // delivered. The Gateway's flag covers a greeting outside the loaded transcript; the transcript
  // covers a status that arrived live, after the snapshot that carried the flag.
  const welcomeState = latestWelcome
    ? welcomeDelivery(
        latestWelcome,
        latestWelcome.welcomeDelivery === "delivered" ||
          latestWelcome.welcomeDelivery === "partial" ||
          state.messages.some((message) => isWelcomeGreeting(latestWelcome, message)),
      )
    : undefined;
  const canRetryWelcome = welcomeState === "undelivered";

  const retryWelcome = async () => {
    if (!latestWelcome || retryingWelcome) return;
    setRetryingWelcome(true);
    setError(undefined);
    try {
      const result = await api.retryBotWelcome(latestWelcome.botId);
      dispatch({ type: "run_status", threadId, run: result.run });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetryingWelcome(false);
    }
  };
  const loadOlderMessages = async () => {
    const first = state.messages[0]?.seq;
    if (first === undefined || loadingOlderMessages) return;
    const lifecycleRevision = lifecycleRevisionRef.current;
    setLoadingOlderMessages(true);
    try {
      const slice = await api.listMessageSlice(threadId, { beforeSeq: first });
      const approvals = await approvalsForRef.current(slice.messages);
      if (lifecycleRevisionRef.current !== lifecycleRevision) return;
      dispatch({ type: "loaded", messages: slice.messages, runs: [], approvals });
      setHasOlderMessages(slice.hasOlder === true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlderMessages(false);
    }
  };
  const loadOlderRuns = async () => {
    if (!runsCursor || loadingOlderRuns) return;
    const lifecycleRevision = lifecycleRevisionRef.current;
    const runSnapshotRevision = runRevisionRef.current;
    setLoadingOlderRuns(true);
    try {
      const page = await api.listRuns({ threadId, cursor: runsCursor });
      if (lifecycleRevisionRef.current !== lifecycleRevision) return;
      dispatch({ type: "loaded", messages: [], runs: page.runs, runSnapshotRevision });
      setRunsCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlderRuns(false);
    }
  };
  const activityByBot = new Map<string, typeof pending>();
  for (const run of [
    ...pending,
    ...botRuns.filter(
      (run) => members.length === 1 && run.threadId !== threadId && !isTerminal(run.status),
    ),
  ]) {
    const current = activityByBot.get(run.botId) ?? [];
    activityByBot.set(run.botId, [...current, run]);
  }
  const memberActivity = new Map<string, string>();
  for (const member of members) {
    const runs = activityByBot.get(member.botId) ?? [];
    const latest = latestRunForBot(state, member.botId);
    const idleLabel =
      latest?.status === "failed" || latest?.status === "cancelled" || latest?.status === "stopped"
        ? runStatusLabel(latest.status)
        : t("chatPane.activity.ready");
    memberActivity.set(
      member.botId,
      runs.length > 0 ? runs.map((run) => runStatusLabel(run.status)).join(", ") : idleLabel,
    );
  }

  // An approval shows up twice in the transcript: the request the hook posted and the echo the
  // decision posted, both `system` messages carrying the same attachment. The first is the card;
  // every later one is a one-line note, so a decided approval never draws two cards.
  const firstApprovalSeq = new Map<string, number>();
  for (const m of state.messages) {
    const ref = approvalRefOf(m.attachments);
    if (ref !== undefined && !firstApprovalSeq.has(ref)) firstApprovalSeq.set(ref, m.seq);
  }

  return (
    <>
      <section
        className={`chat${dropTarget.active ? " chat-drop-active" : ""}`}
        {...dropTarget.handlers}
      >
        <header className="chat-header">
          <div className="chat-header-row">
            <div className="thread-heading">
              <a
                className="icon-button chat-back"
                href="#/threads"
                aria-label={t("chatPane.header.allConversations")}
              >
                <ArrowLeft size={18} />
              </a>
              <h2>{detail?.thread.title || namesTitle(members.map((m) => m.name))}</h2>
              <span className={`connection-status ${connection}`}>
                <span className="status-dot" />
                {t(CONNECTION_LABELS[connection])}
              </span>
              <ApproveAllBadge api={api} workspaceId={detail?.thread.workspaceId} />
              {channelName !== undefined ? (
                <span className="thread-channel small muted" data-testid="thread-channel">
                  {t("chatPane.channelMirror.badge", { channel: channelName })}
                </span>
              ) : null}
              {detail?.thread.deadline ? (
                <span
                  className="thread-deadline small muted"
                  data-testid="thread-deadline"
                  title={detail.thread.deadline}
                >
                  {t(
                    isPastDeadline(detail.thread)
                      ? "chatPane.header.deadlinePassed"
                      : "chatPane.header.deadline",
                    { date: formatDateTime(detail.thread.deadline) },
                  )}
                </span>
              ) : null}
            </div>
            <div className="chat-header-actions">
              {detail !== undefined && browser.loaded ? (
                <TakeoverControls
                  browser={browser}
                  api={api}
                  workspaceId={detail.thread.workspaceId}
                />
              ) : null}
              {props.onToggleInfo ? (
                <button
                  type="button"
                  className="icon-button"
                  id={`chat-info-toggle-${threadId}`}
                  aria-pressed={props.infoShown ?? false}
                  aria-label={
                    props.infoShown ? t("chatPane.header.hideInfo") : t("chatPane.header.showInfo")
                  }
                  title={
                    props.infoShown ? t("chatPane.header.hideInfo") : t("chatPane.header.showInfo")
                  }
                  onClick={props.onToggleInfo}
                >
                  <Info size={18} />
                </button>
              ) : null}
            </div>
          </div>
          {detail ? (
            <button
              type="button"
              className="chat-members-summary"
              onClick={props.onToggleInfo}
              disabled={!props.onToggleInfo}
              title={t("chatPane.header.membersAndInfo")}
            >
              <AvatarStack names={members.map((m) => m.name)} max={4} />
              <span className="muted small">{membersSummary(members, memberActivity)}</span>
            </button>
          ) : null}
        </header>
        {detail?.thread.status === "paused" ? (
          <output className="paused-banner">
            <PauseCircle size={16} aria-hidden="true" />
            <span>{t("chatPane.paused")}</span>
          </output>
        ) : null}
        {members.length > 1 ? (
          <RoundStrip
            round={round}
            api={api}
            botName={botName}
            actorName={actorName}
            onChanged={reloadRounds}
          />
        ) : null}
        <ChatViewport
          label={t("chatPane.viewportLabel")}
          jumpLabel={t("chatPane.jumpToLatest")}
          conversationKey={threadId}
          scrollTargetId={props.messageId ? `message-${props.messageId}` : undefined}
          composer={
            <div className="chat-composer-region">
              {" "}
              <ChatRunStop
                key={threadId}
                api={api}
                runs={pending}
                botName={botName}
                thread={detail?.thread}
                memberCount={members.length}
                onRunUpdated={(run) => {
                  runRevisionRef.current += 1;
                  dispatch({ type: "run_status", threadId, run });
                }}
              />
              {pending.some((run) => run.status === "queued") ? (
                <p className="chat-notice">{t("chatPane.queueNotice")}</p>
              ) : null}
              {canRetryWelcome ? (
                <aside className="message system send-failure" role="alert">
                  <div className="body">{t("chatPane.welcome.failed")}</div>
                  <Button
                    type="button"
                    disabled={retryingWelcome}
                    onClick={() => void retryWelcome()}
                  >
                    {retryingWelcome ? t("chatPane.welcome.retrying") : t("chatPane.welcome.retry")}
                  </Button>
                </aside>
              ) : welcomeState === "partial" && latestWelcome ? (
                <output className="chat-notice">
                  {t("chatPane.welcome.partial", { status: runStatusLabel(latestWelcome.status) })}
                </output>
              ) : null}
              {composer.failed ? (
                <aside className="message system send-failure" role="alert">
                  <div className="meta">
                    <span className="error">
                      {t("chatPane.failed.error", { error: composer.failed.error })}
                    </span>
                  </div>
                  <div className="body">{composer.failed.body}</div>
                  <Button
                    type="button"
                    onClick={() =>
                      restoreFailedConversationSubmission(api, threadId, composer.failed?.id ?? -1)
                    }
                  >
                    {draft.body ? t("chatPane.failed.replaceDraft") : t("chatPane.failed.restore")}
                  </Button>
                  <Button
                    type="button"
                    onClick={() =>
                      dismissFailedConversationSubmission(api, threadId, composer.failed?.id ?? -1)
                    }
                  >
                    {t("chatPane.failed.dismiss")}
                  </Button>
                </aside>
              ) : null}
              {error ? <p className="error">{error}</p> : null}
              {channelName !== undefined ? (
                <div
                  className="composer composer-locked channel-mirror-notice"
                  data-testid="channel-mirror-notice"
                >
                  <p>
                    <strong>{t("chatPane.channelMirror.title", { channel: channelName })}</strong>
                  </p>
                  <p className="muted small">
                    {t("chatPane.channelMirror.body", { channel: channelName })}
                  </p>
                </div>
              ) : canPost.allowed ? null : guest ? (
                // A Guest reads shared chats and cannot post (ADR-0022 amendment 6 W6).
                <div className="composer composer-locked" data-testid="guest-notice">
                  <p className="muted small">{t("chatPane.guest.readOnly")}</p>
                </div>
              ) : (
                <div className="composer composer-locked" data-testid="composer-locked">
                  <RoleNote
                    action={detail?.thread.kind === "bus" ? "thread.postBus" : "thread.post"}
                    allowed={false}
                    does={t("chatPane.composer.roleNote")}
                  />
                  <p className="muted small">{t("chatPane.composer.sideChatHint")}</p>
                </div>
              )}
              <VisionNotice api={api} workspaceId={detail?.thread.workspaceId} members={members} />
              {mirrorChannel !== undefined ? null : (
                <form
                  className="composer"
                  onSubmit={send}
                  hidden={!canPost.allowed}
                  onPaste={onComposerPaste(composerFiles, attachAllowed)}
                >
                  <ComposerAttachmentChips attachments={composerFiles} />
                  <div className="composer-box">
                    <MentionTextarea
                      aria-label={t("chatPane.composer.label")}
                      value={draft.body}
                      onChange={(body) => writeConversationDraft(api, threadId, body)}
                      onSubmit={() => void send()}
                      members={members}
                      groupRouting={detail?.groupRouting}
                      ownerBotId={detail?.thread.ownerBotId}
                      placeholder={
                        members.length > 1
                          ? t("chatPane.composer.placeholderTeam")
                          : members[0]
                            ? t("chatPane.composer.placeholderBot", { name: members[0].name })
                            : t("chatPane.composer.placeholderUnnamed")
                      }
                      footer={
                        <>
                          <ComposerAttachButton
                            attachments={composerFiles}
                            disabled={!attachAllowed}
                          />
                          {members.length > 1 && mentionsEveryone(draft.body) ? (
                            <RoundModeToggle value={roundMode} onChange={setRoundMode} />
                          ) : null}
                          <Button
                            variant="primary"
                            size="icon"
                            aria-label={t("chatPane.composer.send")}
                            type="submit"
                            disabled={
                              sendBlocked ||
                              composerFiles.blocked ||
                              (draft.body.trim().length === 0 && composerFiles.ready.length === 0)
                            }
                          >
                            <ArrowUp size={20} />
                          </Button>
                        </>
                      }
                    />
                  </div>
                  {guest ? (
                    // A Guest's inquiry is answered by a status job (ADR-0022 amendment 7 S2).
                    <p className="composer-hint" data-testid="inquiry-scope">
                      {t("chatPane.guest.inquiryScope")}
                    </p>
                  ) : null}
                  <p className="composer-hint">
                    {t.rich("chatPane.composer.keys", { kbd: (text) => <span>{text}</span> })}
                  </p>
                </form>
              )}
            </div>
          }
        >
          <ol className="transcript" aria-label={t("chatPane.transcript.label")}>
            {hasOlderMessages ? (
              <li className="transcript-older">
                <Button
                  type="button"
                  size="sm"
                  disabled={loadingOlderMessages}
                  onClick={() => void loadOlderMessages()}
                >
                  {loadingOlderMessages
                    ? t("chatPane.transcript.loadingOlder")
                    : t("chatPane.transcript.loadOlder")}
                </Button>
              </li>
            ) : null}
            {transcriptTimeline(state, hasOlderMessages).map((item, index, items) => {
              const previous = items[index - 1];
              const dayLabel =
                item.kind === "message" &&
                (previous === undefined ||
                  previous.kind !== "message" ||
                  formatDay(previous.message.ts) !== formatDay(item.message.ts))
                  ? formatDay(item.message.ts)
                  : undefined;
              const continued =
                item.kind === "message" &&
                previous?.kind === "message" &&
                previous.message.authorKind === item.message.authorKind &&
                previous.message.authorId === item.message.authorId &&
                item.message.authorKind !== "system" &&
                approvalRefOf(previous.message.attachments) === undefined &&
                new Date(item.message.ts).getTime() - new Date(previous.message.ts).getTime() <
                  5 * 60 * 1000;
              if (item.kind === "outcome") {
                const run = item.run;
                const when = formatTime(run.finishedAt ?? run.startedAt ?? run.createdAt);
                return (
                  <li
                    key={`outcome:${run.id}`}
                    className={`message system run-outcome ${run.status}`}
                  >
                    <div className="meta">
                      <span className="author bot">{botName(run.botId)}</span>
                      <span className={`status ${run.status}`}>{runStatusLabel(run.status)}</span>
                      <span className="muted small">{when}</span>
                      <a href={runHref(run.id)} className="small">
                        {t("chatPane.outcome.viewRun")}
                      </a>
                    </div>
                    <div className="body">
                      {run.error ??
                        (run.status === "cancelled"
                          ? t("chatPane.outcome.cancelled")
                          : run.status === "stopped"
                            ? t("chatPane.outcome.stopped")
                            : t("chatPane.outcome.failed"))}
                    </div>
                  </li>
                );
              }
              const m = item.message;
              const ref = approvalRefOf(m.attachments);
              if (ref === undefined)
                return (
                  <MessageRow
                    key={m.id}
                    message={m}
                    botName={botName}
                    api={api}
                    workspaceId={detail?.thread.workspaceId}
                    continued={continued}
                    dayLabel={dayLabel}
                  />
                );
              if (firstApprovalSeq.get(ref) !== m.seq) {
                return (
                  <li
                    key={m.id}
                    id={`message-${m.id}`}
                    className="message system approval-echo"
                    data-testid="approval-echo"
                  >
                    <div className="approval-decision-text">
                      {approvalEchoLabel(m.body, actorName).replace(
                        /bot:(bot_[a-zA-Z0-9_]+)/g,
                        (label, id) => botName(id) ?? label,
                      )}
                      {approvalEchoLabel(m.body, actorName) !== m.body ? (
                        <details>
                          <summary>{t("actor.audit")}</summary>
                          <div>{m.body}</div>
                        </details>
                      ) : null}
                    </div>
                  </li>
                );
              }
              return (
                <li key={m.id} id={`message-${m.id}`} className="message system">
                  <Avatar name="approval" kind="system" />
                  <div className="meta">
                    <span className="author system">{t("chatPane.author.approval")}</span>
                    <span className="muted small">{formatTime(m.ts)}</span>
                  </div>
                  <ApprovalCard
                    approval={state.approvals[ref]}
                    fallbackBody={m.body}
                    api={api}
                    botName={state.approvals[ref] ? botName(state.approvals[ref].botId) : undefined}
                    onDecided={(approval) => dispatch({ type: "approval", threadId, approval })}
                    readOnlyNote={
                      channelName !== undefined
                        ? t("chatPane.channelMirror.approval", { channel: channelName })
                        : undefined
                    }
                  />
                </li>
              );
            })}
            <IncomingHandoffs api={api} threadId={threadId} onRuns={setHandoffRuns} />
            <ReplyPreviews previews={previews} runs={pending} botName={botName} />
            {pending.map((run) => (
              <li key={run.id} className="typing" data-testid="typing">
                <Avatar name={botName(run.botId)} />
                <span className="typing-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="muted">
                  {t.rich("chatPane.typing", {
                    name: botName(run.botId),
                    status: runStatusLabel(run.status),
                    author: (text) => <span className="author bot">{text}</span>,
                    link: (text) => (
                      <a href={runHref(run.id)} className="small">
                        {text}
                      </a>
                    ),
                  })}
                </span>
              </li>
            ))}
          </ol>
          {members.length === 1 && members[0] && !guest ? (
            <PrivateChatActivity
              key={members[0].botId}
              api={api}
              botId={members[0].botId}
              botName={members[0].name}
              threadId={threadId}
            />
          ) : null}
        </ChatViewport>
        {dropTarget.overlay}
      </section>
      {detail ? (
        <ChatInfo
          api={api}
          detail={detail}
          members={members}
          messages={state.messages}
          approvals={Object.values(state.approvals)}
          workspaceId={detail.thread.workspaceId}
          shown={props.infoShown ?? false}
          onClose={props.onToggleInfo}
          activity={
            <ActivityPanel
              runs={Object.values(state.runs)}
              rounds={rounds}
              currentRoundId={round?.messageId}
              botName={botName}
              actorName={actorName}
              loadEvents={(runId) => api.listRunEvents(runId)}
              older={
                runsCursor
                  ? { loading: loadingOlderRuns, onLoad: () => void loadOlderRuns() }
                  : undefined
              }
              onRetry={async (messageId, botId) => {
                await api.retryRoundMember(threadId, messageId, botId);
                reloadRounds();
              }}
            />
          }
          membership={
            <ThreadMembership
              api={api}
              threadId={threadId}
              workspaceId={detail.thread.workspaceId}
              editable={detail.thread.kind === "chat" && mirrorChannel === undefined}
              members={members}
              ownerBotId={ownerBotId}
              activity={memberActivity}
              onChanged={() => refreshDetailRef.current()}
            />
          }
        />
      ) : null}
    </>
  );
}

/**
 * Take over / hand back the one browser this workspace runs. Held, the screen is the same one the
 * bots use, streamed through the Gateway's screen proxy for the lease holder only (ADR-0022
 * amendment 1, C7): no noVNC address or password reaches this page, so it works the same from
 * the Gateway host and from another machine. Until the container exists there is no screen.
 */
function TakeoverControls({
  browser,
  api,
  workspaceId,
}: {
  browser: WorkspaceLockState;
  api: ApiClient;
  workspaceId: WorkspaceId;
}) {
  const t = useT();
  const openTicket = useCallback(() => api.openTakeoverScreen(workspaceId), [api, workspaceId]);
  return (
    <span className="takeover-controls small">
      {browser.held ? (
        <>
          <span className="muted">{t("chatPane.takeover.held")}</span>
          {browser.hasScreen ? (
            <Button type="button" onClick={browser.openScreen} disabled={browser.busy}>
              {t("chatPane.takeover.openScreen")}
            </Button>
          ) : (
            <span className="muted">{t("chatPane.takeover.noScreen")}</span>
          )}
          <Button type="button" onClick={browser.handBack} disabled={browser.busy}>
            {t("chatPane.takeover.handBack")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={browser.takeOver} disabled={browser.busy}>
          {t("chatPane.takeover.takeOver")}
        </Button>
      )}
      {browser.error ? <span className="error">{browser.error}</span> : null}
      <Dialog
        open={browser.screenOpen && browser.hasScreen}
        onOpenChange={(open) => {
          if (!open) browser.closeScreen();
        }}
      >
        <DialogContent>
          <DialogTitle className="text-lg font-semibold">
            {t("chatPane.takeover.screenTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("chatPane.takeover.screenDescription")}
          </DialogDescription>
          {browser.screenOpen && browser.hasScreen ? (
            <DesktopView
              api={api}
              open={openTicket}
              mode="control"
              label={t("chatPane.takeover.screenLabel")}
            />
          ) : null}
          <div className="desktop-dialog-footer">
            <Button type="button" onClick={browser.handBack} disabled={browser.busy}>
              {t("chatPane.takeover.handBack")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

function MessageRow({
  message,
  botName,
  api,
  workspaceId,
  continued = false,
  dayLabel,
}: {
  message: ThreadMessage;
  botName: (botId: string) => string;
  api: ApiClient;
  /** Unknown until the thread detail loads; paths stay plain text until then. */
  workspaceId: WorkspaceId | undefined;
  /** Same author as the row above within a few minutes: the avatar and name are not repeated. */
  continued?: boolean;
  /** First message of a day: a divider is drawn above it. */
  dayLabel?: string | undefined;
}) {
  const t = useT();
  const handoff = message.attachments.find((attachment) =>
    isThreadLinkAttachmentMime(attachment.mimeType),
  );
  const otherAttachments = message.attachments.filter(
    (attachment) => !isThreadLinkAttachmentMime(attachment.mimeType),
  );
  const label =
    message.authorKind === "bot"
      ? botName(message.authorId)
      : message.authorKind === "system"
        ? handoff
          ? t("chatPane.author.handoff")
          : t("chatPane.author.system")
        : t("chatPane.author.human");
  return (
    <>
      {dayLabel ? (
        <li className="day-divider" aria-hidden="true">
          {dayLabel}
        </li>
      ) : null}
      <li
        id={`message-${message.id}`}
        className={`message ${message.authorKind}${handoff ? " handoff" : ""}${continued ? " continued" : ""}`}
      >
        <Avatar
          name={label}
          kind={
            message.authorKind === "bot"
              ? "bot"
              : message.authorKind === "human"
                ? "human"
                : "system"
          }
        />
        <div className="meta">
          <span className={`author ${message.authorKind}`}>{label}</span>
          <span className="muted small">{formatTime(message.ts)}</span>
          {message.runId ? (
            <a href={runHref(message.runId)} className="small" title={message.runId}>
              {t("chatPane.runLink")}
            </a>
          ) : null}
        </div>
        {workspaceId !== undefined &&
        (message.authorKind === "human" || message.authorKind === "bot") ? (
          <MessageBody body={message.body} api={api} workspaceId={workspaceId} />
        ) : (
          <div className="body">{message.body}</div>
        )}
        {handoff ? (
          <a className="handoff-link small" href={threadHref(handoff.ref as ThreadId)}>
            {handoff.name}
          </a>
        ) : null}
        <AttachmentCards attachments={otherAttachments} api={api} workspaceId={workspaceId} />
      </li>
    </>
  );
}

/**
 * A human or bot message body with its workspace paths as download buttons (ADR-0014 decision
 * 5). The body stays text: React escapes it, and a download saves bytes without rendering them.
 */
function MessageBody({
  body,
  api,
  workspaceId,
}: {
  body: string;
  api: ApiClient;
  workspaceId: WorkspaceId;
}) {
  const renderText = (text: string, key: string) =>
    splitWorkspacePaths(text).map((segment, index) =>
      segment.kind === "text" ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable body
        <span key={`${key}-${index}`}>{segment.text}</span>
      ) : (
        <WorkspaceFilePreview
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable body
          key={`${key}-${index}`}
          api={api}
          workspaceId={workspaceId}
          path={segment.path}
        />
      ),
    );
  if (looksLikeMarkdown(body)) {
    return (
      <div className="body md">
        <Markdown text={body} renderText={renderText} />
      </div>
    );
  }
  return <div className="body">{renderText(body, "t")}</div>;
}

/**
 * The display name of a mirrored thread's channel: its plugin's manifest name when the release
 * bundles that plugin, else the channel name itself. Undefined for a thread that is not a mirror.
 */
function useChannelDisplayName(api: ApiClient, channel: string | undefined): string | undefined {
  const [names, setNames] = useState<ReadonlyMap<string, string>>();
  useEffect(() => {
    if (channel === undefined) return;
    let cancelled = false;
    api
      .getChannelCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setNames(
          new Map(catalog.plugins.map((entry) => [entry.manifest.id, entry.manifest.displayName])),
        );
      })
      .catch(() => {
        if (!cancelled) setNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [api, channel]);
  if (channel === undefined) return undefined;
  return names?.get(channel) ?? channel;
}
