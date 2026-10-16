# Live run progress (issue #9)

The chat, the run screen and approval cards show what a run is doing from events the Gateway
already records; nothing here adds an event kind or a model call (ADR-0033 decision 7). The
Gateway side, including the `stalled` status, is in the gateway package's
[run liveness](../../gateway/docs/run-liveness.md) page.

## Chat status row

A running bot's row names its run's current activity, from `features/runs/run-activity.ts`:

- an open tool call (a `tool_call` without the `tool_result` that has its `toolUseId`), shown
  with the tool's short name (an MCP tool without its `mcp__<server>__` prefix) and how long it
  has run;
- otherwise a model request still waiting for its first byte (a Gateway `model_first_byte` span
  that started and has not ended; token-count requests excluded), as "waiting on the model";
- then the run's own elapsed time. The times tick every second while a run is executing.

A `stalled` run has its own state, says it has shown no progress for a while, and still names
what it is stuck on. The activity follows the chat stream's `run_event` frames; when the chat
opens mid-run, each executing run is seeded once with its newest 100 events. Opens and closes are
kept as sets, so a seed and live frames merge in any order. A Guest cannot read run events, so a
Guest's row says only what the status says.

## Run screen

- A tool call and its result are one row with the call's duration and the result's error state;
  a result whose call is on an older page stays its own row.
- `phase_timing` spans are a timeline under "Phase timing": one row per span, nested by parent,
  on one time axis, open spans marked. Spans overlap and are never added up.
- Structured telemetry logs (resource observations, phase timing, startup marks, lock and
  context bookkeeping) are collapsed behind "Show diagnostic log rows". A log with no source, or
  with text, an error, a warning or a stall, always shows.
- `turn_usage`, `model_switch`, `compact_boundary`, `skill_used` and stall changes read as one
  line; their JSON stays behind the row's details.
- The context panel lists the system prompt's sections by size, its hash, the model request
  count with distinct system prompts (with a warning when the prompt changed inside one attempt),
  and, when the CLI was given a window, a meter of the largest input against it.

## Approval cards

A pending card counts down to the end of the 300 s short wait while the run waits live, says
when the run is parked and will resume on a decision, and shows the run's latest screenshot as a
thumbnail linking to the run. In a chat the run's status decides live or parked; in the inbox,
which has no run status, the approval's wait mode and the end of the short wait do.
