import type { EventSink } from "./ledger.js";
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PER_RUN } from "./screenshots.js";

/** Shared by MCP file captures and CLI callbacks; neither source owns an extra allowance. */
export function screenshotRecorder(sink: Pick<EventSink, "emit">) {
  let emitted = 0;
  return (payload: Record<string, unknown> & { bytes: number }): boolean => {
    if (
      emitted >= SCREENSHOT_MAX_PER_RUN ||
      payload.bytes > SCREENSHOT_MAX_BYTES ||
      payload.bytes < 1
    )
      return false;
    emitted++;
    sink.emit("screenshot", { ...payload, captureIndex: emitted });
    return true;
  };
}
