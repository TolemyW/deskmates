// A one-member chat's view of its bot at work elsewhere (chat feedback update of 2026-10-11):
// the bot's runs in other conversations and its background tasks, read through the bot's run
// feed. Finished work sits in the transcript at the time it ended, so yesterday's task never
// reads as the answer to today's question; work in progress sits below the newest message. One
// card per run (ADR-0033), linking to its chat; nothing here writes a message or wakes a bot.

import type { BotId, ThreadId } from "@deskmates/contracts";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import {
  ActivityCard,
  ActivityTriggerLabel,
  LoadOlderRuns,
  type OlderRuns,
  isActivityRun,
} from "../runs/activity.js";
import { useRunFeed } from "../runs/run-feed.js";

export interface ElsewhereActivity {
  /** The bot's activity runs outside this chat, unordered; the transcript timeline places them. */
  runs: readonly RunView[];
  /** Older finished runs exist (#113 slice R). */
  older: OlderRuns | undefined;
  error: string | undefined;
}

/** The feed of this chat's one member; no scope (a group, a Guest) reads nothing. */
export function useElsewhereActivity(
  api: ApiClient,
  scope: { botId: BotId; threadId: ThreadId } | undefined,
  excludeRuns: readonly string[] = [],
): ElsewhereActivity {
  // #113 slice R: unfinished runs plus the newest finished page; older pages on request.
  const { runs, hasOlder, loadingOlder, loadOlder, error } = useRunFeed(
    api,
    scope ? { botId: scope.botId } : undefined,
  );
  // ADR-0033: summary jobs are not activity; a handoff already has its own card (ADR-0024).
  const feed = scope
    ? runs.filter(
        (run) =>
          isActivityRun(run) && run.threadId !== scope.threadId && !excludeRuns.includes(run.id),
      )
    : [];
  return {
    runs: feed,
    older: hasOlder ? { loading: loadingOlder, onLoad: () => void loadOlder() } : undefined,
    error: scope ? error : undefined,
  };
}

/** One run from elsewhere as a transcript row: where it came from, then its card. */
export function ElsewhereActivityItem({
  run,
  api,
  botName,
}: {
  run: RunView;
  api: ApiClient;
  botName: (botId: string) => string;
}) {
  return (
    <li
      className={`message system elsewhere-activity ${run.status}`}
      data-testid="elsewhere-activity"
    >
      <p className="elsewhere-activity-source muted small">
        <ActivityTriggerLabel run={run} />
      </p>
      <ActivityCard
        run={run}
        botName={botName}
        loadEvents={(runId) => api.listRunEvents(runId)}
        markRun={{ mark: api.markRun, unmark: api.unmarkRun }}
        linkThread
      />
    </li>
  );
}

/** Older finished work from elsewhere loads above the transcript, where it belongs in time. */
export function ElsewhereActivityOlder({ older }: { older: OlderRuns | undefined }) {
  if (!older) return null;
  return (
    <li className="transcript-older elsewhere-older">
      <LoadOlderRuns older={older} />
    </li>
  );
}
