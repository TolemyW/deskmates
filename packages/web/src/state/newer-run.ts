// Which of two records for the same run to keep when a fetch and the SSE stream disagree.
//
// A response can be stale: the fetch left the browser before the frame the stream delivered, so it
// describes the run as it was. Run status only ever moves towards a terminal one (contracts,
// `RUN_TRANSITIONS`), so a terminal record is never superseded by a non-terminal one. Everything
// else — queued → running, a parked run resuming — is a legitimate move and the newer record wins.

import { isTerminal } from "@deskmates/contracts";
import type { RunView } from "../api/types.js";

export function newerRun(existing: RunView | undefined, incoming: RunView): RunView {
  if (!existing) return incoming;
  // A reconnect fetch may finish after a continuation has already started another attempt.
  // The attempt number is durable; never rewind its status or accounting to an older one.
  if (incoming.attempt < existing.attempt) return existing;
  if (isTerminal(existing.status) && !isTerminal(incoming.status)) return existing;
  return incoming;
}
