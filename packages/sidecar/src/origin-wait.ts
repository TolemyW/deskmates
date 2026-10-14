import type { BrowserOriginRequest, BrowserOriginResponse, RunId } from "@deskmates/contracts";

export interface BrowserOriginClient {
  browserOrigin(req: BrowserOriginRequest, signal?: AbortSignal): Promise<BrowserOriginResponse>;
}

export interface OriginWaitOptions {
  client: BrowserOriginClient;
  runId: RunId;
  deadlineAt: string;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_RETRY_MS = 100;

function abortError(reason: string): Error {
  return new Error(`Browser origin wait ${reason}`);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError("was cancelled");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError("was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Wait for the Gateway's FIFO origin lease without returning control to the model. Only the
 * explicit `origin_busy` response is retryable; takeover and lost ownership must be surfaced so
 * the caller can verify state rather than silently replaying a browser action.
 */
export async function waitForBrowserOrigin(
  origin: string,
  options: OriginWaitOptions,
): Promise<BrowserOriginResponse> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.parse(options.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error("Invalid browser origin deadline");
  const deadlineAbort = new AbortController();
  const deadlineMs = Math.max(0, deadline - now().getTime());
  const deadlineTimer = setTimeout(() => deadlineAbort.abort(), deadlineMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineAbort.signal])
    : deadlineAbort.signal;
  const request: BrowserOriginRequest = {
    type: "browser_origin",
    runId: options.runId,
    op: "acquire",
    origin,
  };

  const release = async (releaseSignal?: AbortSignal) => {
    await options.client
      .browserOrigin(
        { type: "browser_origin", runId: options.runId, op: "release", origin },
        releaseSignal,
      )
      .catch(() => undefined);
  };

  try {
    for (;;) {
      if (signal.aborted)
        throw abortError(
          deadlineAbort.signal.aborted ? "reached the run deadline" : "was cancelled",
        );
      const remaining = deadline - now().getTime();
      if (remaining <= 0) throw abortError("reached the run deadline");
      const response = await options.client.browserOrigin(request, signal);
      if (signal.aborted || now().getTime() >= deadline) {
        throw abortError(
          deadlineAbort.signal.aborted || now().getTime() >= deadline
            ? "reached the run deadline"
            : "was cancelled",
        );
      }
      if (response.granted) return response;
      if (response.waitReason !== "origin_busy") {
        await release(signal);
        return response;
      }
      const delay = Math.max(1, Math.min(response.retryAfterMs ?? DEFAULT_RETRY_MS, remaining));
      await sleep(delay, signal);
    }
  } catch (error) {
    if (signal.aborted || now().getTime() >= deadline) {
      // Start cleanup, but the expired run deadline remains the hard bound for returning.
      void release();
    } else await release(signal);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
