import {
  type Attachment,
  type BotId,
  DeskmatesError,
  type GroupRouting,
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  type Mention,
  type MessageId,
  RUN_ERROR_TURN_BUDGET,
  type RequestedRoundMode,
  type RoundMode,
  type Run,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type WakeBlockedReason,
  isPastDeadline,
  isTerminal,
  laneForThread,
  parseMentions,
} from "@deskmates/contracts";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import type { WorkspaceLimitStore } from "../limits/workspace-limits.js";
import { type CapBreach, blockedReason, breachLabel, evaluateCaps, fixedCaps } from "./caps.js";
import type { MessageStore } from "./messages.js";
import type { RoundStore } from "./rounds.js";
import type { RoutingWalk, RoutingWalkStore, WalkMode } from "./routing-walks.js";
import type { NamedMember, ThreadStore } from "./threads.js";

export interface PostHumanMessageInput {
  threadId: ThreadId;
  body: string;
  authorId?: string;
  /**
   * A channel adapter's id for the external message (ADR-0017 decision 2). A second post with the
   * same id on the same thread returns the stored message and wakes nobody.
   */
  externalId?: string;
  /** Ask for a definite answer (issue #21). Stored on the message; never changes who is woken. */
  mustReply?: boolean;
  /** Validated by the caller (`asAttachments`); the composite submit's only use (issue #21). */
  attachments?: readonly Attachment[];
  /**
   * ADR-0005 amendment 4, decision 29: one-by-one discussion for this message only. Meaningful
   * only with `@everyone`; parallel is the default.
   */
  roundMode?: RequestedRoundMode;
}

export interface PostResult {
  message: ThreadMessage;
  runs: RunRecord[];
  /** True when `externalId` matched an existing message: nothing was appended or woken. */
  duplicate?: boolean;
  /** The thread is past its deadline (issue #21): the message was stored and woke nobody. */
  deadlinePassed?: true;
}

/** A bot's own post: the stored message, and why it started no run when it started none. */
export interface BotPostOutcome {
  message: ThreadMessage;
  wakeBlocked?: WakeBlockedReason;
}

const TEXT_MENTION = /(^|[^\w@])@([\w-]+)/g;

export interface ThreadRouterOptions {
  batch?: <T>(work: () => T) => T;
  onBotMessage?: (run: Run, message: ThreadMessage, blocked?: string) => void;
  /**
   * How a message with no explicit recipient is routed (ADR-0005 amendment 2). A router built
   * without options keeps decision 4 as first written; the Gateway passes its configured value.
   */
  groupRouting?: GroupRouting;
  /** The thread row changed (its owner), so operator clients reload the thread. */
  onThreadChanged?: (threadId: ThreadId) => void;
  /** Durable request rounds (ADR-0005 amendment 4); a router without it records none. */
  rounds?: RoundStore;
  /** Workspace caps (amendment 5); a router without them keeps decision 6's fixed caps. */
  limits?: Pick<WorkspaceLimitStore, "threadCaps">;
  /**
   * ADR-0026 amendment 1: a paused bot is never woken. A router without it treats every bot as
   * awake.
   */
  isPaused?: (botId: BotId) => boolean;
}

export class ThreadRouter {
  constructor(
    private readonly threads: ThreadStore,
    private readonly messages: MessageStore,
    private readonly runs: RunStore,
    private readonly runConfig: () => Record<string, unknown>,
    private readonly walks: RoutingWalkStore,
    private readonly events?: EventStore,
    private readonly onRunsCreated: (runs: readonly RunRecord[]) => void = () => {},
    private readonly onMessageCreated: (message: ThreadMessage) => void = () => {},
    private readonly options: ThreadRouterOptions = {},
  ) {}

  private get ownerRouting(): boolean {
    return this.options.groupRouting === "owner-v1";
  }

  postHuman(input: PostHumanMessageInput): PostResult {
    return this.walks.transaction(() => {
      let thread = this.threads.mustGet(input.threadId);
      if (input.externalId !== undefined) {
        const existing = this.messages.findByExternalId(thread.id, input.externalId);
        if (existing) return { message: existing, runs: [], duplicate: true };
      }
      this.joinHumanMentions(thread.id, input.body);
      if (thread.status === "paused") thread = this.threads.setStatus(thread.id, "active");
      const members = this.threads.members(thread.id);
      const message = this.messages.append({
        threadId: thread.id,
        authorKind: "human",
        authorId: input.authorId ?? "web",
        body: input.body,
        mentions: parseMentions(input.body, members),
        relayCount: 0,
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.mustReply === true ? { mustReply: true } : {}),
      });
      if (this.ownerRouting && members.length > 1 && thread.kind === "chat") {
        this.adoptAddressedOwner(thread, message);
      }
      // Issue #21: past the deadline the message is kept and the caller is told nothing started.
      if (isPastDeadline(thread)) return { message, runs: [], deadlinePassed: true };
      return { message, runs: this.route(thread, members, message, false, input.roundMode) };
    });
  }

  postFromRun(
    run: Run,
    body: string,
    attachments: ThreadMessage["attachments"] = [],
  ): ThreadMessage {
    return this.postFromRunRouted(run, body, attachments).message;
  }

  /**
   * `postFromRun` plus why no run started, for the caller that has to tell the posting run
   * (issue #68). The reason travels beside the message, never on it: the message object is the
   * stored row that is also published on the event bus.
   */
  postFromRunRouted(
    run: Run,
    body: string,
    attachments: ThreadMessage["attachments"] = [],
  ): BotPostOutcome {
    if (!run.threadId) {
      throw new DeskmatesError("validation", "run has no thread to post into", { runId: run.id });
    }
    const post = () => this.postBotMessage(run, run.threadId as ThreadId, body, attachments);
    return this.options.batch ? this.options.batch(post) : post();
  }

  postFromRunToThread(
    run: Run,
    threadId: ThreadId,
    body: string,
    attachments: ThreadMessage["attachments"],
    targetBotId: BotId,
  ): ThreadMessage {
    return this.postBotMessage(run, threadId, body, attachments, targetBotId).message;
  }

  postSystem(
    threadId: ThreadId,
    body: string,
    attachments: readonly Attachment[] = [],
    opts: { wakeExcept?: BotId; wakeOnly?: BotId; runId?: Run["id"]; inert?: true } = {},
  ): PostResult {
    const thread = this.threads.mustGet(threadId);
    const members = this.threads.members(threadId);
    const message = this.messages.append({
      threadId,
      authorKind: "system",
      authorId: "",
      body,
      attachments,
      relayCount: 0,
      // The run the message is about, for a delegation outcome notice (ADR-0016 amendment 1).
      ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    });
    if (isPastDeadline(thread)) return { message, runs: [], deadlinePassed: true };
    // A routing-inert notice (an approval request, reminder or expiry, ADR-0002 amendment 3 A4).
    if (opts.inert) return { message, runs: [] };
    const runs = members
      .filter((member) => member.botId !== opts.wakeExcept)
      .filter((member) => opts.wakeOnly === undefined || member.botId === opts.wakeOnly)
      // A notice is not a request: a paused member reads it when it is next woken.
      .filter((member) => !this.options.isPaused?.(member.botId))
      .filter((member) => !this.runs.findQueued(member.botId, threadId))
      .map((member) => this.createWake(thread, member.botId, message));
    return { message, runs };
  }

  /** Scheduler entry point: resume busy or restart-interrupted durable walks. */
  continueWalks(): RunRecord[] {
    const created = this.walks
      .pendingThreadIds()
      .flatMap((threadId) => this.walks.transaction(() => this.advanceThreadWalk(threadId)));
    if (created.length > 0) this.onRunsCreated(created);
    return created;
  }

  /** A terminal run releases its member in an in-turn walk. Parked runs do not. */
  runEnded(run: RunRecord): RunRecord[] {
    if (!isTerminal(run.status) || !run.threadId) return [];
    const created = this.walks.transaction(() => this.advanceThreadWalk(run.threadId as ThreadId));
    if (created.length > 0) this.onRunsCreated(created);
    return created;
  }

  /**
   * A `message_bot` call from a chat run put a handoff line in that thread. For a member being
   * offered an unaddressed request this is taking it (ADR-0005 amendment 2, decision 14).
   */
  handedOff(run: Run): void {
    const threadId = run.threadId;
    if (!threadId) return;
    this.walks.transaction(() => this.noteTaken(run, threadId));
  }

  /**
   * ADR-0005 amendment 5, decision 38: the effective relay cap and turn budget of a thread, `off`
   * falling back to the loop breaker's ceilings; a turn budget that is off with the volume rule
   * off too is null (no message-count bound). `message_bot` and the outcome notices of ADR-0016
   * decision 11 read the same values the router checks.
   */
  effectiveCaps(threadId: ThreadId): { relayCountMax: number; turnBudget: number | null } {
    const thread = this.threads.mustGet(threadId);
    const caps =
      this.options.limits?.threadCaps(thread.workspaceId, thread.turnBudget) ??
      fixedCaps(thread.turnBudget);
    return {
      relayCountMax: caps.relayCountMax.value ?? LOOP_BREAKER_RELAY_MAX,
      turnBudget: caps.turnBudget.value ?? (caps.volumeBreaker ? LOOP_BREAKER_BOT_MESSAGES : null),
    };
  }

  wakeTargets(members: readonly NamedMember[], mentions: readonly Mention[]): BotId[] {
    const explicit = mentions.filter((m): m is { kind: "bot"; botId: BotId } => m.kind === "bot");
    if (explicit.length > 0) return explicit.map((m) => m.botId);
    const first = members[0];
    return first ? [first.botId] : [];
  }

  private postBotMessage(
    run: Run,
    threadId: ThreadId,
    body: string,
    attachments: ThreadMessage["attachments"],
    forceTarget?: BotId,
  ): BotPostOutcome {
    const work = (): {
      message: ThreadMessage;
      runs: RunRecord[];
      changed: RunRecord[];
      wakeBlocked?: WakeBlockedReason;
    } => {
      const thread = this.threads.mustGet(threadId);
      const members = this.threads.members(thread.id);
      if (!members.some((member) => member.botId === run.botId)) {
        throw new DeskmatesError("validation", "posting bot is not a member of the thread", {
          runId: run.id,
          threadId,
        });
      }
      if (forceTarget && !members.some((member) => member.botId === forceTarget)) {
        throw new DeskmatesError("validation", "target bot is not a member of the thread", {
          targetBotId: forceTarget,
          threadId,
        });
      }
      const source = this.messages.get(run.triggerRef as ThreadMessage["id"]);
      let sourceRelay = source?.relayCount ?? 0;
      const deliveredSeq = (run as Run & { deliveredSeq?: number }).deliveredSeq;
      if (run.threadId && deliveredSeq !== undefined && deliveredSeq > 0) {
        const sourceMember = this.threads.member(run.threadId, run.botId);
        if (sourceMember) {
          sourceRelay = this.messages.maxRelayInRange(
            run.threadId,
            sourceMember.lastSeenSeq,
            deliveredSeq,
            run.botId,
          );
        }
      }
      const relayCount = sourceRelay + 1;
      const mentions: Mention[] = forceTarget
        ? [{ kind: "bot", botId: forceTarget }]
        : parseMentions(body, members, run.botId);
      const message = this.messages.append({
        threadId,
        authorKind: "bot",
        authorId: run.botId,
        body,
        attachments,
        mentions,
        relayCount,
        runId: run.id,
      });
      this.noteTaken(run, threadId);
      // ADR-0005 amendment 5: the workspace's caps, then the loop breaker behind them.
      const caps = this.options.limits?.threadCaps(thread.workspaceId, thread.turnBudget);
      const breaches = evaluateCaps(caps ?? fixedCaps(thread.turnBudget), {
        relayCount,
        botCount: this.messages.botCountSinceLastHuman(threadId),
        repeats: this.messages.botRepeatsSinceLastHuman(message),
      });
      const wakeBlocked = blockedReason(breaches);
      if (!forceTarget)
        this.options.onBotMessage?.(
          run,
          message,
          breaches.some((breach) => !breach.pauses)
            ? "relay cap reached"
            : wakeBlocked
              ? "turn budget reached"
              : thread.status === "paused"
                ? "conversation is paused"
                : undefined,
        );
      if (wakeBlocked) {
        const changed: RunRecord[] = [];
        for (const breach of breaches) changed.push(...this.breach(thread, message, breach));
        return { message, runs: [], changed, wakeBlocked };
      }
      if (thread.status === "paused") {
        return { message, runs: [], changed: [], wakeBlocked: "thread_paused" };
      }
      // `route()` starts nothing past the deadline either; saying so here lets the caller tell
      // the posting run why.
      if (isPastDeadline(thread)) {
        return { message, runs: [], changed: [], wakeBlocked: "deadline_passed" };
      }
      const created = forceTarget
        ? this.directWakes(thread, message, this.withoutPaused(thread, message, [forceTarget]))
        : this.route(thread, members, message, false);
      return { message, runs: created, changed: [] };
    };
    const result = this.walks.transaction(work);
    if (result.runs.length > 0 || result.changed.length > 0) {
      this.onRunsCreated([...result.runs, ...result.changed]);
    }
    return {
      message: result.message,
      ...(result.wakeBlocked === undefined ? {} : { wakeBlocked: result.wakeBlocked }),
    };
  }

  private route(
    thread: Thread,
    members: readonly NamedMember[],
    message: ThreadMessage,
    publish: boolean,
    requested?: RequestedRoundMode,
  ): RunRecord[] {
    // A thread past its deadline starts no run (issue #21); the scheduler cancels what is left.
    if (isPastDeadline(thread)) return [];
    const explicit = message.mentions.filter(
      (mention): mention is { kind: "bot"; botId: BotId } => mention.kind === "bot",
    );
    const everyone = message.mentions.some((mention) => mention.kind === "everyone");
    const sequential = message.authorKind === "human" && requested === "sequential";
    let created: RunRecord[];
    if (explicit.length > 0) {
      const targets = this.withoutPaused(
        thread,
        message,
        explicit.map((m) => m.botId),
      );
      if (message.authorKind === "human") this.openRound(thread, message, "parallel", targets);
      created = this.directWakes(thread, message, targets);
    } else if (everyone && !sequential) {
      // Amendment 4, decision 28: every eligible member at once; a bot never consults itself.
      const targets = this.withoutPaused(
        thread,
        message,
        members
          .filter((member) => message.authorKind !== "bot" || member.botId !== message.authorId)
          .map((member) => member.botId),
      );
      this.openRound(thread, message, "parallel", targets);
      created = this.directWakes(thread, message, targets);
    } else created = this.routeUnaddressed(thread, members, message);
    if (publish && created.length > 0) this.onRunsCreated(created);
    return created;
  }

  /** Decision 30: the durable round of an accepted originating message, with its parent. */
  private openRound(
    thread: Thread,
    message: ThreadMessage,
    mode: RoundMode,
    botIds: readonly BotId[],
  ): void {
    const rounds = this.options.rounds;
    if (!rounds || thread.status === "paused" || botIds.length === 0) return;
    rounds.open({
      messageId: message.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      mode,
      botIds,
      parentMessageId: message.runId ? rounds.roundOfRun(message.runId) : undefined,
    });
  }

  private relate(
    messageId: MessageId,
    botId: BotId,
    run: RunRecord,
    relation: "created" | "coalesced" | "retry",
  ): void {
    this.options.rounds?.relate(messageId, botId, run.id, relation);
  }

  /**
   * Decision 35: one new wake for a round member whose latest related run failed or stopped. A
   * live retry is returned instead of a second one; a cancelled round or a removed member is
   * refused.
   */
  retryRoundMember(messageId: MessageId, botId: BotId): { run: RunRecord; created: boolean } {
    const result = this.walks.transaction(() => {
      const round = this.options.rounds?.get(messageId);
      if (!round) throw new DeskmatesError("not_found", "round not found", { messageId });
      const member = round.members.find((m) => m.botId === botId);
      if (!member) throw new DeskmatesError("not_found", "bot is not in this round", { botId });
      if (round.cancelledAt !== undefined)
        throw new DeskmatesError("invalid_transition", "the round was cancelled", { messageId });
      if (!this.threads.member(round.threadId, botId))
        throw new DeskmatesError("invalid_transition", "the bot is no longer a member", { botId });
      const latest = member.runId ? this.runs.get(member.runId) : undefined;
      if (latest && !isTerminal(latest.status)) return { run: latest, created: false };
      if (member.state !== "failed" && member.state !== "stopped")
        throw new DeskmatesError(
          "invalid_transition",
          "only a failed or stopped member is retried",
          {
            state: member.state,
          },
        );
      if (this.options.isPaused?.(botId))
        throw new DeskmatesError("invalid_transition", "the bot is paused; resume it first", {
          botId,
        });
      const thread = this.threads.mustGet(round.threadId);
      if (thread.status === "paused" || isPastDeadline(thread))
        throw new DeskmatesError(
          "invalid_transition",
          "the conversation is paused or past its deadline",
          {
            threadId: thread.id,
          },
        );
      const message = this.messages.mustGet(messageId);
      const queued = this.runs.findQueued(botId, thread.id);
      if (queued) {
        this.relate(messageId, botId, queued, "retry");
        return { run: queued, created: false };
      }
      const run = this.createWake(thread, botId, message);
      this.relate(messageId, botId, run, "retry");
      return { run, created: true };
    });
    if (result.created) this.onRunsCreated([result.run]);
    return result;
  }

  /**
   * No explicit recipient. Decision 4 walks every member for every such message. Under
   * `owner-v1` (amendment 2) only `@everyone` still does: an unaddressed human message is
   * offered until one member takes it (decision 14), and an unaddressed bot message in a chat
   * thread wakes nobody (decision 17). A bus thread has no human and two members, so a bot's
   * unaddressed message there still reaches the other one.
   */
  private routeUnaddressed(
    thread: Thread,
    members: readonly NamedMember[],
    message: ThreadMessage,
  ): RunRecord[] {
    const everyone = message.mentions.some((mention) => mention.kind === "everyone");
    // A one-member thread is a plain chat: there is nobody to offer to and nothing to own. A
    // bus thread has no human in it and no owner; whoever writes there is walked as before.
    if (!this.ownerRouting || everyone || members.length < 2 || thread.kind !== "chat") {
      return this.enqueueWalk(thread, message, members, "all");
    }
    if (message.authorKind === "human") {
      return this.enqueueWalk(thread, message, members, "first_taker");
    }
    return [];
  }

  /**
   * Decision 15: a human who addresses exactly one bot in a thread that has no owner names it.
   * An existing owner keeps the thread: asking a specialist one question does not take the task
   * away from whoever coordinates it.
   */
  private adoptAddressedOwner(thread: Thread, message: ThreadMessage): void {
    if (thread.ownerBotId !== undefined) return;
    const bots = message.mentions.filter(
      (mention): mention is { kind: "bot"; botId: BotId } => mention.kind === "bot",
    );
    const only = bots[0];
    if (bots.length !== 1 || !only || message.mentions.length !== 1) return;
    if (this.threads.setOwner(thread.id, only.botId)) this.options.onThreadChanged?.(thread.id);
  }

  /** The run the walk woke posted into the walk's thread: for an offer, that member took it. */
  private noteTaken(run: Run, threadId: ThreadId): void {
    const walk = this.walks.activeForRun(run.id);
    if (!walk || walk.mode !== "first_taker" || walk.threadId !== threadId) return;
    this.takeWalk(walk, run.botId, run);
  }

  private takeWalk(walk: RoutingWalk, botId: BotId, run?: Run): void {
    this.walks.take(walk.messageId, botId);
    const changed = this.threads.setOwner(walk.threadId, botId);
    if (run && this.events) {
      this.events.append({
        runId: run.id,
        kind: "log",
        payload: {
          source: "group_owner",
          threadId: walk.threadId,
          messageId: walk.messageId,
          ownerBotId: botId,
          changed,
        },
      });
    }
    if (changed) this.options.onThreadChanged?.(walk.threadId);
  }

  /** Decision 16: the owner is offered first, then the other members in join order. */
  private offerOwnerFirst(walk: RoutingWalk): void {
    const owner = this.threads.mustGet(walk.threadId).ownerBotId;
    if (owner === undefined) return;
    const order = this.walks.members(walk.messageId);
    if (order[0] === owner || !order.includes(owner)) return;
    this.walks.reorder(walk.messageId, [owner, ...order.filter((botId) => botId !== owner)]);
  }

  /** Decision 18: every member was offered the request and none took it. Wakes nobody. */
  private announceNobodyTook(thread: Thread, walk: RoutingWalk): void {
    const offered = this.walks.members(walk.messageId);
    if (thread.kind !== "chat" || offered.length < 2) return;
    const message = this.messages.mustGet(walk.messageId);
    // Workspace names, not current members: one who passed may have been removed since.
    const names = this.threads.workspaceBotNames(thread.id);
    const how = (botId: BotId): string => {
      const run = this.runs.findByTriggerRef(botId, walk.messageId);
      if (!run) return "had already seen it";
      if (run.status === "failed") return "failed";
      if (run.status === "stopped") return "was stopped";
      if (run.status === "cancelled") return "was cancelled";
      return "ended without a reply";
    };
    const alert = this.messages.append({
      threadId: thread.id,
      authorKind: "system",
      authorId: "",
      body: `No member replied to message #${message.seq}: ${offered
        .map((botId) => `${names.get(botId) ?? botId} ${how(botId)}`)
        .join("; ")}. Mention a member to assign it.`,
      relayCount: 0,
    });
    this.onMessageCreated(alert);
  }

  private directWakes(
    thread: Thread,
    message: ThreadMessage,
    targets: readonly BotId[],
  ): RunRecord[] {
    if (thread.status === "paused" || isPastDeadline(thread)) return [];
    const created: RunRecord[] = [];
    for (const botId of targets) {
      // Decision 8 coalesces into a queued wake; amendment 4 decision 31 records it explicitly.
      const queued = this.runs.findQueued(botId, thread.id);
      if (queued) {
        this.relate(message.id, botId, queued, "coalesced");
        continue;
      }
      const run = this.createWake(thread, botId, message);
      this.relate(message.id, botId, run, "created");
      created.push(run);
    }
    return created;
  }

  private enqueueWalk(
    thread: Thread,
    message: ThreadMessage,
    members: readonly NamedMember[],
    mode: WalkMode,
  ): RunRecord[] {
    if (thread.status === "paused") return [];
    const awake = new Set(
      this.withoutPaused(
        thread,
        message,
        members.map((member) => member.botId),
      ),
    );
    const targets = (
      message.authorKind === "bot"
        ? members.filter((member) => member.botId !== message.authorId)
        : members
    ).filter((member) => awake.has(member.botId));
    if (targets.length === 0) return [];
    this.walks.enqueue(
      message.id,
      thread.id,
      targets.map((member) => member.botId),
      mode,
    );
    // A human request (or an explicitly sequential @everyone) is a round; a bot's unaddressed
    // message in a walk-v1 or bus thread is not a new request.
    if (message.authorKind === "human")
      this.openRound(
        thread,
        message,
        mode === "first_taker" ? "offer" : "sequential",
        targets.map((member) => member.botId),
      );
    const created = this.advanceThreadWalk(thread.id);
    if (created.length > 0) return created;
    // Preserve the original one-member API contract: a message arriving while its only session
    // is live gets one queued row immediately. A group cannot reserve a later walk's first member:
    // that queued row could make an older walk wait for the very run the scheduler holds behind it.
    const first = targets[0];
    if (
      members.length === 1 &&
      first &&
      this.runs.liveInThread(first.botId, thread.id) &&
      !this.runs.findQueued(first.botId, thread.id)
    ) {
      const reserved = this.createWake(thread, first.botId, message);
      this.walks.setActive(message.id, reserved.id);
      this.relate(message.id, first.botId, reserved, "created");
      return [reserved];
    }
    return [];
  }

  private advanceThreadWalk(threadId: ThreadId): RunRecord[] {
    const thread = this.threads.mustGet(threadId);
    if (thread.status === "paused" || isPastDeadline(thread)) return [];
    for (;;) {
      let walk = this.walks.oldestPending(threadId);
      if (!walk) return [];
      if (walk.activeRunId) {
        const active = this.runs.get(walk.activeRunId);
        if (active && !isTerminal(active.status)) return [];
        walk = this.walks.finishMember(walk.messageId);
      }
      const offer = walk.mode === "first_taker";
      if (offer && walk.nextMemberIndex === 0) this.offerOwnerFirst(walk);
      const botId = this.walks.member(walk.messageId, walk.nextMemberIndex);
      if (!botId) {
        this.walks.complete(walk.messageId);
        if (offer) this.announceNobodyTook(thread, walk);
        continue;
      }
      const message = this.messages.mustGet(walk.messageId);
      // Paused after the walk began: passed over like a member that has seen the message.
      if (this.options.isPaused?.(botId)) {
        this.notePaused(thread, message, [botId]);
        this.walks.finishMember(walk.messageId);
        continue;
      }
      const member = this.threads.member(threadId, botId);
      // A successful/silent run from an earlier walk may already have delivered this queued
      // message. It satisfies this member without another model call; failures do not advance
      // last_seen_seq, so their message is retried here.
      if (member && member.lastSeenSeq >= message.seq) {
        // For an offer, a member that saw the request in an earlier run and wrote after it has
        // answered it there.
        if (offer && this.messages.botAnsweredAfterSeeing(threadId, botId, message.seq)) {
          this.takeWalk(walk, botId);
          continue;
        }
        this.walks.finishMember(walk.messageId);
        continue;
      }
      const lane = laneForThread(thread.kind);
      if (this.runs.laneOccupiedForWalk(botId, lane)) return [];
      const run = this.createWake(thread, botId, message);
      this.walks.setActive(walk.messageId, run.id);
      this.relate(walk.messageId, botId, run, "created");
      return [run];
    }
  }

  /**
   * ADR-0026 amendment 1: drop paused bots from a wake and say so in the thread, once per message.
   * The message stays unseen by them, so the first wake after they are resumed delivers it.
   */
  private withoutPaused(thread: Thread, message: ThreadMessage, botIds: readonly BotId[]): BotId[] {
    const isPaused = this.options.isPaused;
    const paused = isPaused ? botIds.filter((botId) => isPaused(botId)) : [];
    if (paused.length === 0) return [...botIds];
    this.notePaused(thread, message, paused);
    return botIds.filter((botId) => !paused.includes(botId));
  }

  private notePaused(thread: Thread, message: ThreadMessage, paused: readonly BotId[]): void {
    const names = this.threads.workspaceBotNames(thread.id);
    const who = paused.map((botId) => names.get(botId) ?? botId).join(", ");
    const notice = this.messages.append({
      threadId: thread.id,
      authorKind: "system",
      authorId: "",
      body: `${who} ${paused.length === 1 ? "is" : "are"} paused and was not woken by message #${message.seq}. A paused bot reads what it missed when it is resumed and woken again.`,
      relayCount: 0,
    });
    this.onMessageCreated(notice);
  }

  private createWake(thread: Thread, botId: BotId, message: ThreadMessage): RunRecord {
    return this.runs.create({
      botId,
      threadId: thread.id,
      lane: laneForThread(thread.kind),
      triggerKind: "thread_message",
      triggerRef: message.id,
      config: this.runConfig(),
    });
  }

  private breach(thread: Thread, message: ThreadMessage, breach: CapBreach): RunRecord[] {
    const changed: RunRecord[] = [];
    if (breach.pauses) {
      this.threads.setStatus(thread.id, "paused");
      for (const queued of this.runs.listQueuedInThread(thread.id)) {
        // The Gateway decided this outcome, so the run names why, as a deadline cancellation does.
        changed.push(
          this.runs.transition(queued.id, "cancelled", { error: RUN_ERROR_TURN_BUDGET }),
        );
      }
      this.walks.completePendingInThread(thread.id);
    }
    const names = new Map(
      this.threads.members(thread.id).map((member) => [member.botId, member.name]),
    );
    const dropped =
      message.mentions
        .filter((m): m is { kind: "bot"; botId: BotId } => m.kind === "bot")
        .map((m) => names.get(m.botId) ?? m.botId)
        .join(", ") || "thread members";
    const alert = this.messages.append({
      threadId: thread.id,
      authorKind: "system",
      authorId: "",
      body: `${breachLabel(breach)}: ${names.get(message.authorId as BotId) ?? message.authorId}'s mention of ${dropped} was not delivered`,
      relayCount: 0,
    });
    this.onMessageCreated(alert);
    if (message.runId && this.events) {
      // Amendment 5, decision 41: which counter, which limit, and where the limit came from.
      const { cap, limit, source, rule } = breach;
      this.events.append({
        runId: message.runId,
        kind: "cap_breached",
        payload: {
          cap,
          thread_id: thread.id,
          message_id: message.id,
          limit,
          source,
          ...(rule ? { rule } : {}),
        },
      });
    }
    return changed;
  }

  /**
   * The workspace bots a human message would add to the thread by mentioning them (a mention of
   * a bot that is not a member joins it). Reads only; `postHuman` does the joining.
   */
  mentionsThatJoin(threadId: ThreadId, body: string): BotId[] {
    const members = new Set(this.threads.members(threadId).map((member) => member.botId));
    const joining: BotId[] = [];
    for (const name of mentionedNames(body)) {
      const botId = this.threads.botByNameInWorkspace(threadId, name);
      if (botId && !members.has(botId) && !joining.includes(botId)) joining.push(botId);
    }
    return joining;
  }

  private joinHumanMentions(threadId: ThreadId, body: string): void {
    for (const name of mentionedNames(body)) {
      const botId = this.threads.botByNameInWorkspace(threadId, name);
      if (botId) {
        this.threads.addMember(threadId, botId);
      } else {
        const outside = this.threads.botByNameOutsideWorkspace(threadId, name);
        if (outside) {
          throw new DeskmatesError("validation", `bot ${name} belongs to another workspace`, {
            botId: outside,
            threadId,
          });
        }
      }
    }
  }
}

/** The distinct `@name` mentions of a human message, `@everyone` excluded. */
function mentionedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(TEXT_MENTION)) {
    const name = match[2];
    if (name && name.toLowerCase() !== "everyone") names.add(name);
  }
  return names;
}
