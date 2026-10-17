// Live activity of a chat's executing runs (issue #9): what each one is doing now, from the
// `run_event` frames the chat's stream already carries, seeded once per run with the newest
// slice of its ledger so a chat opened mid-run shows the tool already at work. A Guest cannot
// read run events; the seed then fails quietly and the row says only what the status says.

import { type RunEvent, type RunId, isExecuting } from "@deskmates/contracts";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../../api/client.js";
import type { GatewayEvent, RunView } from "../../api/types.js";
import { type RunActivityMap, runActivityReducer } from "../runs/run-activity.js";

/** How many newest events seed a run's activity; an open call older than this is not shown. */
export const RUN_ACTIVITY_SEED = 100;

export interface LiveRunActivity {
  activity: RunActivityMap;
  /** Feed every SSE frame of the chat; only `run_event` frames are read. */
  apply: (event: GatewayEvent) => void;
}

export function useRunActivity(
  api: Pick<ApiClient, "listRunEventSlice">,
  threadId: string,
  runs: readonly RunView[],
): LiveRunActivity {
  const [activity, dispatch] = useReducer(runActivityReducer, {});
  const seeded = useRef(new Set<RunId>());
  // Bumped when the thread changes or the chat unmounts; a seed from before is dropped.
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread starts from nothing.
  useEffect(() => {
    generation.current += 1;
    seeded.current = new Set();
    dispatch({ type: "reset" });
    return () => {
      generation.current += 1;
    };
  }, [threadId]);

  const executing = runs
    .filter((run) => isExecuting(run.status))
    .map((run) => run.id)
    .sort()
    .join(",");
  useEffect(() => {
    const live = new Set(executing === "" ? [] : (executing.split(",") as RunId[]));
    for (const runId of [...seeded.current]) {
      if (live.has(runId)) continue;
      seeded.current.delete(runId);
      dispatch({ type: "forget", runId });
    }
    const current = generation.current;
    for (const runId of live) {
      if (seeded.current.has(runId)) continue;
      seeded.current.add(runId);
      api
        .listRunEventSlice(runId, { limit: RUN_ACTIVITY_SEED })
        .then((slice) => {
          if (generation.current === current && seeded.current.has(runId))
            dispatch({ type: "events", runId, events: slice.events });
        })
        .catch(() => {
          // Not allowed to read events, or a transient error: live frames still arrive.
        });
    }
  }, [api, executing]);

  const apply = useCallback((event: GatewayEvent) => {
    if (event.type !== "run_event") return;
    const runEvent: RunEvent = event.event;
    dispatch({ type: "events", runId: runEvent.runId, events: [runEvent] });
  }, []);

  return { activity, apply };
}
