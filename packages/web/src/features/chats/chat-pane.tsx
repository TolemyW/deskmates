import { ChatViewport } from "@deskmates/ui";
import { ArrowLeft, ArrowUp, Info, MoreHorizontal } from "lucide-react";
import { Avatar, AvatarStack } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { useTuneView } from "../../lib/interface-view.js";
import { Markdown, looksLikeMarkdown } from "../../lib/markdown.js";
import { approvalEchoLabel } from "../../state/actor-label.js";
import type { DesktopMember } from "../computer/desktop-rail.js";
import { TakeoverDisplay } from "../computer/takeover-display.js";
import { ActivityNoticeRow, activityNotice } from "./activity-notice.js";
import { AttachmentCards } from "./attachment-cards.js";
import { ChatApproval } from "./chat-approval.js";
import { ChatInfo } from "./chat-info.js";
import { ChatRunStatus } from "./chat-run-status.js";
import { CompactRunError } from "./compact-run-error.js";
import {
  ComposerAttachButton,
  ComposerAttachmentChips,
  onComposerPaste,
  useChatDropTarget,
  useComposerAttachments,
} from "./composer-attachments.js";
import {
  currentFailure,
  everydayHistory,
  isInternalJob,
  routingNoticeKey,
} from "./everyday-history.js";
import { HandoffMessage, handoffPresentation, hasHandoffOutcome } from "./handoff-message.js";
import { IncomingHandoffs } from "./incoming-handoffs.js";
import {
  ElsewhereActivityError,
  ElsewhereActivityItem,
  ElsewhereActivityOlder,
  useElsewhereActivity,
} from "./private-chat-activity.js";
import { RoundCard, showsRoundCard } from "./round-card.js";
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
import {
  ApiError,
  type NamedThreadMember,
  type RunView,
  type ThreadDetailView,
} from "../../api/types.js";
import { DeletedObjectState } from "../../components/deleted-object-state.js";
import { errorMessage, formatDateTime, formatDay, formatTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useLocale, useT } from "../../i18n/i18n-provider.js";
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
import {
  RoleNote,
  useActorLabel,
  useCan,
  useCanPost,
  useIsGuest,
  useWorkspaceRole,
} from "../../state/session-roles.js";
import {
  EMPTY_THREAD_VIEW,
  activeRuns,
  latestRunForBot,
  runStatusLabel,
  threadViewReducer,
  transcriptTimeline,
} from "../../state/thread-view.js";
import { approvalRefOf } from "../approvals/approval-card.js";
import { ApproveAllBadge } from "../approvals/approval-mode.js";
import { splitWorkspacePaths } from "../files/path-links.js";
import { ActivityPanel } from "../runs/activity.js";
import { firstRunPages } from "../runs/run-feed.js";
import { MentionTextarea } from "./mention-textarea.js";
import { MessageContent } from "./message-content.js";
import { MessageContext } from "./message-context.js";
import { ThreadMembership } from "./thread-membership.js";
import { ThreadPausedBanner, humanMessageResumes } from "./thread-paused-banner.js";

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

import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";
import { ReplyPreviews, replyPreviewReducer } from "./reply-preview.js";
import { useRunActivity } from "./use-run-activity.js";
import { type WorkspaceLockState, useWorkspaceLock } from "./use-workspace-lock.js";
import { VisionNotice, useBlindMembers } from "./vision-notice.js";

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
  const [headerActionsOpen, setHeaderActionsOpen] = useState(false);
  const headerOptions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!headerActionsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerOptions.current?.contains(event.target))
        setHeaderActionsOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHeaderActionsOpen(false);
      headerOptions.current?.querySelector<HTMLButtonElement>(".chat-header-more")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [headerActionsOpen]);

  const tune = useTuneView();
  const { threadId } = props;
  const api = props.api ?? defaultApi;
  const t = useT();
  const actorName = useActorLabel();
  const [state, dispatch] = useReducer(threadViewReducer, EMPTY_THREAD_VIEW);
  const [previews, applyPreview] = useReducer(replyPreviewReducer, {});
  // Issue #9: what each live run is doing now, for the status row.
  const { activity: runActivity, apply: applyRunActivity } = useRunActivity(
    api,
    threadId,
    activeRuns(state),
  );
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
  // Issue #15: what the first message does where no container exists. An archived workspace's
  // message is refused (`invalid_transition`); otherwise the run it starts creates the container.
  const containerHint: MessageKey | undefined = detail?.workspaceArchived
    ? "chatPane.composer.containerArchived"
    : browser.container === "never_created"
      ? "chatPane.composer.containerNeverCreated"
      : browser.container === "removed"
        ? "chatPane.composer.containerRemoved"
        : undefined;
  // A Member posts in shared chats, never a bus thread; a Guest nowhere (ADR-0022 amendment 6).
  const canPost = useCanPost(detail?.thread, members.length);
  // ADR-0005 amendment 3, decision 23: an Owner or Admin pauses and resumes the conversation.
  const canPause = useCan("thread.pause", detail?.thread.workspaceId);
  const [resuming, setResuming] = useState(false);
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
  const internalCollaboration = detail?.thread.kind === "bus" && mirrorChannel === "internal";
  const channelName = useChannelDisplayName(api, mirrorChannel);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const [retryingWelcome, setRetryingWelcome] = useState(false);
  const [handoffRuns, setHandoffRuns] = useState<readonly string[]>([]);
  // A one-member chat also shows its bot's work elsewhere (other conversations, background
  // tasks); a handoff that already has its own card is not repeated. Groups and Guests read none.
  const elsewhere = useElsewhereActivity(
    api,
    members.length === 1 && members[0] && !guest
      ? { botId: members[0].botId, threadId }
      : undefined,
    handoffRuns,
  );
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
  // ADR-0023 amendment 2 decision 14: members whose model cannot see what gets attached.
  const blindNames = useBlindMembers(api, detail?.thread.workspaceId, members);
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
    let terminal = false;
    let stop = (): void => {};
    let detailRequest = 0;
    setError(undefined);
    setMissing(false);
    dispatch({ type: "reset" });
    applyPreview({ type: "reset" });
    setRunsCursor(undefined);
    setHasOlderMessages(false);
    runRevisionRef.current = 0;
    setDetail(undefined);

    const fail = (err: unknown): void => {
      if (cancelled || terminal) return;
      if (err instanceof ApiError && err.status === 404) {
        terminal = true;
        setMissing(true);
        stop();
        return;
      }
      setError(errorMessage(err));
    };

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

    stop = subscribeEvents({
      threadId,
      onEvent: (event) => {
        if (cancelled) return;
        if (event.type === "run_status") runRevisionRef.current += 1;
        dispatch(event);
        applyPreview(event);
        applyRunActivity(event);
        // Messages can add a member or pause/reset the thread; run changes affect each member's
        // activity. Refresh the authoritative detail while the reducer applies the live frame.
        if (
          event.type === "thread_message" ||
          event.type === "thread_members" ||
          event.type === "run_status"
        ) {
          void refreshDetail().catch((err: unknown) => {
            fail(err);
          });
        }
      },
      onStatus: (s) => {
        if (!cancelled) setConnection(s);
      },
      // Frames emitted while the stream was down are never replayed, so recover them by hand.
      onReconnect: () => {
        void refetch().catch((err: unknown) => {
          fail(err);
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
        fail(err);
      });
    return () => {
      cancelled = true;
      if (lifecycleRevisionRef.current === lifecycleRevision) lifecycleRevisionRef.current += 1;
      stop();
    };
  }, [threadId, api, applyRunActivity]);

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
      // A human message resumes a thread paused by its turn budget, never one an operator paused
      // (ADR-0005 amendment 3, decision 24); the refresh below brings the authoritative row.
      const current = detailRef.current;
      if (current && humanMessageResumes(current.thread)) {
        const { pauseReason: _reason, resumeAt: _resumeAt, ...rest } = current.thread;
        const next = { ...current, thread: { ...rest, status: "active" as const } };
        setDetail(next);
        onThreadUpdatedRef.current?.(next.thread);
      }
      void refreshDetailRef.current().catch((err: unknown) => setError(errorMessage(err)));
    } catch (err) {
      const message = errorMessage(err);
      failConversationSubmission(api, threadId, submission.id, message);
    }
  };

  // Pause or Resume (decision 23); the answer is the authoritative thread detail.
  const setThreadStatus = async (status: "paused" | "active"): Promise<void> => {
    setResuming(true);
    try {
      const next = await api.setThreadStatus(threadId, status);
      setDetail(next);
      onThreadUpdatedRef.current?.(next.thread, next.members);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResuming(false);
    }
  };

  const pending = activeRuns(state).filter((run) => tune || !isInternalJob(run));
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
  // Once the conversation has moved on (a human or bot message after the welcome, other than
  // the welcome's own), its banner would only sit above every later exchange.
  const conversationMovedOn =
    latestWelcome !== undefined &&
    state.messages.some(
      (message) =>
        message.authorKind !== "system" &&
        message.runId !== latestWelcome.id &&
        message.ts > latestWelcome.createdAt,
    );
  const canRetryWelcome = welcomeState === "undelivered" && !conversationMovedOn;

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
  for (const run of [...pending, ...elsewhere.runs.filter((run) => !isTerminal(run.status))]) {
    const current = activityByBot.get(run.botId) ?? [];
    activityByBot.set(run.botId, [...current, run]);
  }
  const memberActivity = new Map<string, string>();
  for (const member of members) {
    const runs = activityByBot.get(member.botId) ?? [];
    const latest = tune
      ? latestRunForBot(state, member.botId)
      : Object.values(state.runs)
          .filter((run) => run.botId === member.botId && currentFailure(run, state))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .at(-1);
    const idleLabel =
      latest &&
      (latest.status === "failed" || latest.status === "cancelled" || latest.status === "stopped")
        ? runStatusLabel(latest.status)
        : t("chatPane.activity.ready");
    // One entry per status with its count ("queued ×3"), so several runs of one bot never read as
    // a list of repeated states (#126); the run list under the composer has the per-run detail.
    const byStatus = new Map<string, number>();
    for (const run of runs) {
      const label = runStatusLabel(run.status);
      byStatus.set(label, (byStatus.get(label) ?? 0) + 1);
    }
    memberActivity.set(
      member.botId,
      runs.length > 0
        ? [...byStatus].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ")
        : idleLabel,
    );
  }

  // An approval shows up twice in the transcript: the request the hook posted and the echo the
  // decision posted, both `system` messages carrying the same attachment. The first is the card;
  // later receipts live inside its audit disclosure once the decision has loaded.
  const firstApprovalSeq = new Map<string, number>();
  for (const m of state.messages) {
    const ref = approvalRefOf(m.attachments);
    if (ref !== undefined && !firstApprovalSeq.has(ref)) firstApprovalSeq.set(ref, m.seq);
  }

  const fullTimeline = transcriptTimeline(state, hasOlderMessages, elsewhere.runs);
  const timeline = tune ? fullTimeline : everydayHistory(fullTimeline, state, props.messageId);

  const lastConversationMessage = state.messages.filter((m) => m.authorKind !== "system").at(-1);

  if (missing)
    return (
      <section className="chat">
        <DeletedObjectState />
      </section>
    );

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
              <h2 title={detail?.thread.title || namesTitle(members.map((m) => m.name))}>
                {detail?.thread.title || namesTitle(members.map((m) => m.name))}
              </h2>
              <span
                className={`connection-status ${connection}`}
                title={t(CONNECTION_LABELS[connection])}
                aria-label={t(CONNECTION_LABELS[connection])}
              >
                <span className="status-dot" />
                {connection !== "open" ? t(CONNECTION_LABELS[connection]) : null}
              </span>
              <ApproveAllBadge api={api} workspaceId={detail?.thread.workspaceId} />
              {channelName !== undefined ? (
                <span className="thread-channel small muted" data-testid="thread-channel">
                  {internalCollaboration
                    ? t("chatPane.collaboration.badge")
                    : t("chatPane.channelMirror.badge", { channel: channelName })}
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
            <div className="chat-header-options" ref={headerOptions}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="chat-header-more"
                aria-label={t("chatPane.header.moreActions")}
                aria-expanded={headerActionsOpen}
                aria-controls={`chat-actions-${threadId}`}
                onClick={() => setHeaderActionsOpen((open) => !open)}
              >
                <MoreHorizontal size={18} />
              </Button>
              <div
                className="chat-header-actions"
                id={`chat-actions-${threadId}`}
                data-open={headerActionsOpen}
              >
                {detail && members.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="chat-members-summary"
                    onClick={props.onToggleInfo}
                    disabled={!props.onToggleInfo}
                    title={t("chatPane.header.membersAndInfo")}
                  >
                    <AvatarStack names={members.map((m) => m.name)} max={4} />
                    <span className="muted small">
                      {t("chatPane.summary.bots", { count: members.length })}
                    </span>
                  </Button>
                ) : null}
                {detail !== undefined && browser.loaded ? (
                  <TakeoverControls
                    browser={browser}
                    api={api}
                    workspaceId={detail.thread.workspaceId}
                    members={members}
                  />
                ) : null}
                {props.onToggleInfo ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    id={`chat-info-toggle-${threadId}`}
                    aria-pressed={props.infoShown ?? false}
                    aria-label={
                      props.infoShown
                        ? t("chatPane.header.hideInfo")
                        : t("chatPane.header.showInfo")
                    }
                    title={
                      props.infoShown
                        ? t("chatPane.header.hideInfo")
                        : t("chatPane.header.showInfo")
                    }
                    onClick={props.onToggleInfo}
                  >
                    <Info size={18} />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </header>
        {detail ? (
          <ThreadPausedBanner
            thread={detail.thread}
            resuming={resuming}
            onResume={canPause.allowed ? () => void setThreadStatus("active") : undefined}
          />
        ) : null}
        {members.length > 1 && showsRoundCard(detail?.groupRouting, round) ? (
          <RoundCard
            round={round}
            botName={botName}
            actorName={actorName}
            messageBody={(id) => state.messages.find((m) => m.id === id)?.body}
          />
        ) : members.length > 1 ? (
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
              {detail?.thread.status === "paused" && detail.thread.pauseReason === "operator" ? (
                <p className="chat-notice" data-testid="operator-paused-notice">
                  {t("chatPane.operatorPausedComposer")}
                </p>
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
              ) : welcomeState === "partial" && latestWelcome && !conversationMovedOn ? (
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
                    <strong>
                      {internalCollaboration
                        ? t("chatPane.collaboration.title")
                        : t("chatPane.channelMirror.title", { channel: channelName })}
                    </strong>
                  </p>
                  <p className="muted small">
                    {internalCollaboration
                      ? t("chatPane.collaboration.body")
                      : t("chatPane.channelMirror.body", { channel: channelName })}
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
              {mirrorChannel !== undefined ? null : (
                <form
                  className="composer"
                  onSubmit={send}
                  hidden={!canPost.allowed}
                  onPaste={onComposerPaste(composerFiles, attachAllowed)}
                >
                  {composerFiles.uploads.jobs.length > 0 ? (
                    <VisionNotice names={blindNames} />
                  ) : null}
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
                            blindNames={blindNames}
                          />
                          {members.length > 1 &&
                          detail?.groupRouting !== "round-v1" &&
                          mentionsEveryone(draft.body) ? (
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
                  {containerHint ? (
                    <p className="composer-hint" data-testid="container-hint">
                      {t(containerHint)}
                    </p>
                  ) : null}
                  <p className="composer-hint composer-key-hint">
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
            {tune ? <ElsewhereActivityOlder older={elsewhere.older} /> : null}
            {timeline.map((item, index, items) => {
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
              if (item.kind === "elsewhere")
                return (
                  <ElsewhereActivityItem
                    key={`elsewhere:${item.run.id}`}
                    run={item.run}
                    api={api}
                    botName={botName}
                  />
                );
              if (item.kind === "outcome") {
                const run = item.run;
                if (hasHandoffOutcome(run, state.messages)) return null;
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
                      {run.error ? (
                        <CompactRunError error={run.error} />
                      ) : run.status === "cancelled" ? (
                        t("chatPane.outcome.cancelled")
                      ) : run.status === "stopped" ? (
                        t("chatPane.outcome.stopped")
                      ) : (
                        t("chatPane.outcome.failed")
                      )}
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
                    bots={props.bots}
                    latest={lastConversationMessage?.id === m.id}
                    reveal={props.messageId === m.id}
                    botName={botName}
                    api={api}
                    workspaceId={detail?.thread.workspaceId}
                    continued={continued}
                    dayLabel={dayLabel}
                  />
                );
              if (firstApprovalSeq.get(ref) !== m.seq) {
                if (state.approvals[ref]?.decision !== undefined) return null;
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
                <li key={m.id} id={`message-${m.id}`} className="message system chat-approval">
                  <ChatApproval
                    receipts={state.messages.filter(
                      (receipt) =>
                        receipt.seq !== m.seq && approvalRefOf(receipt.attachments) === ref,
                    )}
                    reveal={
                      props.messageId === m.id ||
                      state.messages.some(
                        (receipt) =>
                          receipt.id === props.messageId &&
                          approvalRefOf(receipt.attachments) === ref,
                      )
                    }
                    approval={state.approvals[ref]}
                    fallbackBody={m.body}
                    api={api}
                    botName={state.approvals[ref] ? botName(state.approvals[ref].botId) : undefined}
                    runStatus={
                      state.approvals[ref]
                        ? state.runs[state.approvals[ref].runId]?.status
                        : undefined
                    }
                    onDecided={(approval) => dispatch({ type: "approval", threadId, approval })}
                    readOnlyNote={
                      internalCollaboration
                        ? t("chatPane.collaboration.approval")
                        : channelName !== undefined
                          ? t("chatPane.channelMirror.approval", { channel: channelName })
                          : undefined
                    }
                  />
                </li>
              );
            })}
            <IncomingHandoffs api={api} threadId={threadId} onRuns={setHandoffRuns} />
            <ReplyPreviews previews={previews} runs={pending} botName={botName} />
            <ChatRunStatus
              approvalRunIds={
                new Set(
                  Object.values(state.approvals)
                    .filter(
                      (approval) =>
                        approval.decision === undefined && firstApprovalSeq.has(approval.id),
                    )
                    .map((approval) => approval.runId),
                )
              }
              key={threadId}
              api={api}
              runs={pending}
              activity={runActivity}
              botName={botName}
              messageBody={(id) => state.messages.find((m) => m.id === id)?.body}
              thread={detail?.thread}
              memberCount={members.length}
              onRunUpdated={(run) => {
                runRevisionRef.current += 1;
                dispatch({ type: "run_status", threadId, run });
              }}
            />
          </ol>
          <ElsewhereActivityError activity={elsewhere} />
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
          {...(canPause.allowed && !guest
            ? {
                onSetStatus: (status: "paused" | "active") => void setThreadStatus(status),
                statusBusy: resuming,
              }
            : {})}
          activity={
            <ActivityPanel
              runs={Object.values(state.runs)}
              rounds={rounds}
              currentRoundId={round?.messageId}
              botName={botName}
              actorName={actorName}
              loadEvents={(runId) => api.listRunEvents(runId)}
              markRun={{ mark: api.markRun, unmark: api.unmarkRun }}
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
 * Take over / hand back the one browser this workspace runs. Start with the chat member's
 * region; the overview remains available. Both stream through the Gateway for the lease holder only (ADR-0022
 * amendment 1, C7): no noVNC address or password reaches this page, so it works the same from
 * the Gateway host and from another machine. Until the container exists there is no screen.
 */
function TakeoverControls({
  browser,
  api,
  workspaceId,
  members,
}: {
  browser: WorkspaceLockState;
  api: ApiClient;
  workspaceId: WorkspaceId;
  members: readonly DesktopMember[];
}) {
  const t = useT();
  const role = useWorkspaceRole(workspaceId);
  const mayTake = role === undefined || role !== "guest";
  const mayRelease =
    role !== "guest" &&
    (role === undefined || browser.heldByMe || role === "owner" || role === "admin");
  return (
    <span className="takeover-controls small">
      {browser.held ? (
        <>
          <span className="muted">{t("chatPane.takeover.held")}</span>
          {browser.hasScreen && browser.heldByMe ? (
            <Button type="button" onClick={browser.openScreen} disabled={browser.busy}>
              {t("chatPane.takeover.openScreen")}
            </Button>
          ) : (
            <span className="muted takeover-note" title={t("chatPane.takeover.noScreen")}>
              {t("chatPane.takeover.noScreen")}
            </span>
          )}
          {mayRelease ? (
            <Button type="button" onClick={browser.handBack} disabled={browser.busy}>
              {t("chatPane.takeover.handBack")}
            </Button>
          ) : null}
        </>
      ) : mayTake && browser.hasScreen ? (
        <Button type="button" onClick={browser.takeOver} disabled={browser.busy}>
          {t("chatPane.takeover.takeOver")}
        </Button>
      ) : null}
      {browser.error ? <span className="error">{browser.error}</span> : null}
      <Dialog
        open={browser.screenOpen && browser.hasScreen}
        onOpenChange={(open) => {
          if (!open) browser.closeScreen();
        }}
      >
        <DialogContent className="desktop-dialog">
          <DialogTitle className="text-lg font-semibold">
            {t("chatPane.takeover.screenTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("chatPane.takeover.screenDescription")}
          </DialogDescription>
          {browser.screenOpen && browser.hasScreen ? (
            <TakeoverDisplay api={api} workspaceId={workspaceId} members={members} />
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
  bots,
  latest,
  reveal,
  botName,
  api,
  workspaceId,
  continued = false,
  dayLabel,
}: {
  message: ThreadMessage;
  bots: readonly BotDefinition[] | undefined;
  latest: boolean;
  reveal: boolean;
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
  const locale = useLocale();
  const tune = useTuneView();
  const noticeKey = routingNoticeKey(message);
  const handoff = message.attachments.find((attachment) =>
    isThreadLinkAttachmentMime(attachment.mimeType),
  );
  const presentedHandoff = handoffPresentation(message);
  const otherAttachments = message.attachments.filter(
    (attachment) => !isThreadLinkAttachmentMime(attachment.mimeType),
  );
  const activity = activityNotice(message);
  const label =
    message.authorKind === "bot"
      ? botName(message.authorId)
      : message.authorKind === "system"
        ? handoff || presentedHandoff
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
      {activity ? (
        <ActivityNoticeRow message={message} notice={activity} bots={bots} reveal={reveal} />
      ) : (
        <li
          id={`message-${message.id}`}
          data-latest={latest && message.authorKind === "bot" ? "true" : undefined}
          className={`message ${message.authorKind}${handoff || presentedHandoff ? " handoff" : ""}${continued ? " continued" : ""}`}
        >
          {message.authorKind !== "human" ? (
            <Avatar name={label} kind={message.authorKind === "bot" ? "bot" : "system"} />
          ) : null}
          <div className="meta">
            {message.authorKind !== "human" ? (
              <span className={`author ${message.authorKind}`}>{label}</span>
            ) : null}
            <MessageContext message={message} botName={botName} />
            <time
              className="message-time muted small"
              dateTime={message.ts}
              title={formatDateTime(message.ts)}
            >
              {new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
                new Date(message.ts),
              )}
            </time>
            {message.runId ? (
              <a
                href={runHref(message.runId)}
                className="small message-run-link"
                title={message.runId}
              >
                {t("chatPane.runLink")}
              </a>
            ) : null}
          </div>
          {!tune && noticeKey ? (
            <div className="body">{t(noticeKey)}</div>
          ) : presentedHandoff ? (
            <HandoffMessage message={message} presentation={presentedHandoff} />
          ) : (
            <MessageContent
              body={message.body}
              author={label}
              collapsible={message.authorKind === "bot"}
              prominent={latest}
              reveal={reveal}
              renderBody={(body) =>
                workspaceId !== undefined &&
                (message.authorKind === "human" || message.authorKind === "bot") ? (
                  <MessageBody body={body} api={api} workspaceId={workspaceId} />
                ) : (
                  <div className="body">{body}</div>
                )
              }
            />
          )}
          {handoff && !presentedHandoff ? (
            <a className="handoff-link small" href={threadHref(handoff.ref as ThreadId)}>
              {handoff.name}
            </a>
          ) : null}
          <AttachmentCards attachments={otherAttachments} api={api} workspaceId={workspaceId} />
        </li>
      )}
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
          inline
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
