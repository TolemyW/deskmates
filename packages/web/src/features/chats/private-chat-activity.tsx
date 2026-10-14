import type { BotId, ThreadId } from "@deskmates/contracts";
import { ChevronDown } from "lucide-react";
import { useEffect } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { useT } from "../../i18n/i18n-provider.js";
import { ActivityPanel, isActivityRun } from "../runs/activity.js";
import { useRunFeed } from "../runs/run-feed.js";

/** Read-only projection of work elsewhere; never adds messages to the bot's context. */
export function PrivateChatActivity({
  api,
  botId,
  botName,
  threadId,
  excludeRuns = [],
  onRuns,
}: {
  api: ApiClient;
  botId: BotId;
  botName?: string | undefined;
  threadId: ThreadId;
  excludeRuns?: readonly string[];
  onRuns?: (runs: readonly RunView[]) => void;
}) {
  const t = useT();
  // #113 slice R: unfinished runs plus the newest finished page; older pages on request.
  const { runs, hasOlder, loadingOlder, loadOlder, error } = useRunFeed(api, { botId });
  useEffect(() => {
    onRuns?.(runs.filter(isActivityRun));
  }, [runs, onRuns]);
  // ADR-0033: one card per run, grouped by its round or trigger; summary jobs are not activity.
  const feed = runs.filter(
    (run) => isActivityRun(run) && run.threadId !== threadId && !excludeRuns.includes(run.id),
  );
  if (!feed.length && !error && !hasOlder) return null;
  return (
    <section className="private-chat-activity">
      <details open>
        <summary>
          <ChevronDown size={16} aria-hidden="true" />
          {t("privateChatActivity.title")}
        </summary>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <ActivityPanel
          runs={feed}
          botName={() => botName ?? t("privateChatActivity.bot")}
          loadEvents={(runId) => api.listRunEvents(runId)}
          linkThreads
          older={hasOlder ? { loading: loadingOlder, onLoad: () => void loadOlder() } : undefined}
        />
      </details>
    </section>
  );
}
