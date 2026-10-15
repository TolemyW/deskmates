// The current request round above the transcript (ADR-0005 amendment 4, decision 36): who asked,
// when, what, in which mode, how many members are done and how each one stands. It reads the
// durable round, so a failure from an earlier request never shows here. Prominence only: it
// never admits, blocks or orders work.

import type { BotId, RoundMemberState, ThreadId, ThreadRound } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage, formatTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

export const STATE_LABEL: Readonly<Record<RoundMemberState, MessageKey>> = {
  pending: "roundStrip.state.pending",
  queued: "roundStrip.state.queued",
  running: "roundStrip.state.running",
  awaiting_approval: "roundStrip.state.awaitingApproval",
  paused: "roundStrip.state.paused",
  replied: "roundStrip.state.replied",
  silent: "roundStrip.state.silent",
  failed: "roundStrip.state.failed",
  cancelled: "roundStrip.state.cancelled",
  stopped: "roundStrip.state.stopped",
  seen: "roundStrip.state.seen",
  skipped: "roundStrip.state.skipped",
  removed: "roundStrip.state.removed",
};

/** The newest top-level round: a nested consultation belongs to its parent's request. */
export function currentRound(rounds: readonly ThreadRound[]): ThreadRound | undefined {
  return rounds.find((round) => round.parentMessageId === undefined);
}

/**
 * The thread's rounds, newest first, reloaded whenever `revision` changes (a message or a run
 * status arrived). An older response never replaces a newer one.
 */
export function useThreadRounds(
  api: ApiClient,
  threadId: ThreadId,
  revision: string,
): { rounds: ThreadRound[]; reload: () => void } {
  const [rounds, setRounds] = useState<ThreadRound[]>([]);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `tick` are reload triggers
  useEffect(() => {
    let live = true;
    api
      .listRounds(threadId, 20)
      .then((next) => {
        // An older Gateway (or a stub) without the route answers no list: show no round.
        if (live) setRounds(Array.isArray(next) ? next : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, threadId, revision, tick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another thread's rounds are not this one's
  useEffect(() => setRounds([]), [threadId]);
  return { rounds, reload: () => setTick((n) => n + 1) };
}

export function RoundStrip({
  round,
  api,
  botName,
  actorName,
  onChanged,
}: {
  round: ThreadRound | undefined;
  api: ApiClient;
  botName: (botId: string) => string;
  actorName: (actor: string) => string;
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!round) return null;
  const who = round.authorKind === "bot" ? botName(round.authorId) : actorName(round.authorId);
  const retry = async (botId: BotId) => {
    setBusy(botId);
    setError(undefined);
    try {
      await api.retryRoundMember(round.threadId, round.messageId, botId);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="round-strip" aria-label={t("roundStrip.label")} data-testid="round-strip">
      <p className="round-strip-head">
        <strong>{t("roundStrip.current")}</strong>
        {" · "}
        <span>{who}</span> <time dateTime={round.createdAt}>{formatTime(round.createdAt)}</time>
        <span className="round-strip-message">「{round.excerpt}」</span>
        {round.total > 1 ? (
          <span className="round-strip-mode">
            {t(
              round.mode === "sequential"
                ? "roundMode.sequential"
                : round.mode === "offer"
                  ? "roundStrip.offer"
                  : "roundMode.parallel",
            )}
          </span>
        ) : null}
        {" · "}
        <span>{t("roundStrip.done", { done: round.completed, total: round.total })}</span>
        {round.cancelledAt ? <span className="muted"> · {t("roundStrip.cancelled")}</span> : null}
      </p>
      <ul className="round-strip-members">
        {round.members.map((member) => (
          <li key={member.botId} className={`round-member ${member.state}`}>
            <span className="round-member-name">{botName(member.botId)}</span>
            <span className="round-member-state">{t(STATE_LABEL[member.state])}</span>
            {(member.state === "failed" || member.state === "stopped") &&
            round.cancelledAt === undefined ? (
              <button
                type="button"
                className="link small"
                disabled={busy !== undefined}
                onClick={() => void retry(member.botId)}
              >
                {t("roundStrip.retry")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Decision 29: the per-message mode, shown only once `@everyone` is in the draft. */
export function RoundModeToggle({
  value,
  onChange,
}: {
  value: "parallel" | "sequential";
  onChange: (value: "parallel" | "sequential") => void;
}) {
  const t = useT();
  return (
    <fieldset
      className="round-mode-toggle segmented"
      aria-label={t("roundMode.label")}
      data-testid="round-mode-toggle"
    >
      {(["parallel", "sequential"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {t(mode === "parallel" ? "roundMode.parallel" : "roundMode.sequential")}
        </button>
      ))}
    </fieldset>
  );
}

/** Whether a draft addresses everyone, the only case the mode applies to. */
export function mentionsEveryone(body: string): boolean {
  return /(^|[^\w@])@everyone(?![\w-])/i.test(body);
}
