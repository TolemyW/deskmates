// Streamed reply preview in the chat (ADR-0037 decision 7). A live run's `run_reply_preview`
// frames are kept per run, newest wins by (attempt, seq); the bubble is provisional and goes away
// when the run's final message arrives or the run stops being live. The final message is the
// record; a preview is never stored and never shown for a run that is not running.

import { type ReplyPreviewFrame, type RunId, supersedesPreview } from "@deskmates/contracts";
import type { GatewayEvent, RunView } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { useT } from "../../i18n/i18n-provider.js";

export type ReplyPreviewState = Readonly<Record<string, ReplyPreviewFrame>>;

const LIVE = new Set(["running", "stalled", "waiting_approval_live"]);

function without(state: ReplyPreviewState, runId: RunId): ReplyPreviewState {
  if (!(runId in state)) return state;
  const next = { ...state };
  delete next[runId];
  return next;
}

/** Applies one SSE frame; any other event leaves the state as it is. */
export function replyPreviewReducer(
  state: ReplyPreviewState,
  event: GatewayEvent | { type: "reset" },
): ReplyPreviewState {
  switch (event.type) {
    case "reset":
      return {};
    case "run_reply_preview": {
      const { preview } = event;
      return supersedesPreview(state[preview.runId], preview)
        ? { ...state, [preview.runId]: preview }
        : state;
    }
    case "thread_message":
      return event.message.authorKind === "bot" && event.message.runId
        ? without(state, event.message.runId)
        : state;
    case "run_status":
      return LIVE.has(event.run.status) ? state : without(state, event.run.id);
    default:
      return state;
  }
}

/** One provisional bubble per live run that has a preview, in the runs' order. */
export function ReplyPreviews({
  previews,
  runs,
  botName,
}: {
  previews: ReplyPreviewState;
  runs: readonly RunView[];
  botName: (botId: string) => string;
}) {
  const t = useT();
  return (
    <>
      {runs
        .filter((run) => LIVE.has(run.status) && previews[run.id]?.text)
        .map((run) => {
          const name = botName(run.botId);
          return (
            <li
              key={`preview:${run.id}`}
              className="message bot reply-preview"
              data-testid="reply-preview"
              aria-live="polite"
            >
              <Avatar name={name} kind="bot" />
              <div className="meta">
                <span className="author bot">{name}</span>
                <span className="muted small">{t("chatPane.replyPreview.label")}</span>
              </div>
              <div className="body">{previews[run.id]?.text}</div>
            </li>
          );
        })}
    </>
  );
}
