import { type Task, isTerminal } from "@deskmates/contracts";
import { useEffect, useRef } from "react";
import { subscribeEvents } from "../../api/events.js";

/** A task follows its recorded activity; unrelated workspace runs never refresh this editor. */
export function useTaskLiveRefresh(task: Task | undefined, refresh: () => Promise<void>) {
  const latest = useRef({ task, refresh });
  latest.current = { task, refresh };
  const taskId = task?.id;
  const workspaceId = task?.workspaceId;
  useEffect(() => {
    if (!taskId || !globalThis.EventSource) return;
    return subscribeEvents({
      onReconnect: () => void latest.current.refresh(),
      onEvent: (event) => {
        const current = latest.current.task;
        if (!current || current.workspaceId !== workspaceId) return;
        const relevantMessage =
          event.type === "thread_message" && current.threadIds.includes(event.threadId);
        const relevantFinish =
          event.type === "run_status" &&
          isTerminal(event.run.status) &&
          (current.runIds.includes(event.run.id) ||
            (event.run.threadId != null && current.threadIds.includes(event.run.threadId)));
        if (relevantMessage || relevantFinish) void latest.current.refresh();
      },
    });
  }, [taskId, workspaceId]);
}
