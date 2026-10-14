import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";

/** Keep pipe errors handled through the final drain, including Node's deferred error event. */
export function guardProxyPipes(
  output: Writable,
  childInput: Writable,
  disconnect: () => void,
): { failed(): boolean; close(): Promise<void> } {
  let failed = false;
  const onError = () => {
    if (failed) return;
    failed = true;
    disconnect();
  };
  output.on("error", onError);
  childInput.on("error", onError);
  return {
    failed: () => failed,
    close: async () => {
      try {
        // main() calls process.exit. A successful final write must reach the client first;
        // a client that has closed its pipe cannot receive a result and must not crash us.
        if (!output.destroyed && !output.writableEnded) {
          await new Promise<void>((resolve) => output.write("", () => resolve()));
        }
        // Writable invokes its callback before emitting the corresponding error. Removing
        // the listener in the callback would leave the final EPIPE unhandled again.
        await setImmediate();
      } finally {
        output.removeListener("error", onError);
        childInput.removeListener("error", onError);
      }
    },
  };
}
