export interface TransientReadError {
  message: string;
  code?: string;
}

export interface RetryReadOptions {
  deadlineAt: number;
  retryDelayMs: number;
  /** Bound for one GET; this never extends `deadlineAt`. */
  attemptTimeoutMs?: number;
  onTransientError?: (error: TransientReadError) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ReadDeadlineError extends Error {
  constructor() {
    super("read deadline exceeded");
    this.name = "ReadDeadlineError";
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Only retry failures that Node fetch identifies as transport failures. A plain TypeError from
 * acceptance code is a programming error and must remain immediately visible.
 */
export function transientFetchError(error: unknown): TransientReadError | undefined {
  if (!(error instanceof TypeError)) return undefined;
  const cause = (error as TypeError & { cause?: unknown }).cause;
  const code = errorCode(cause) ?? errorCode(error);
  if (error.message !== "fetch failed" && (code === undefined || !NETWORK_ERROR_CODES.has(code))) {
    return undefined;
  }
  return {
    message: "fetch failed",
    ...(code && NETWORK_ERROR_CODES.has(code) ? { code } : {}),
  };
}

/** Retry one idempotent read within an existing absolute deadline. */
export async function retryTransientRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  options: RetryReadOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 10_000;
  for (;;) {
    const remaining = options.deadlineAt - now();
    if (remaining <= 0) throw new ReadDeadlineError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, attemptTimeoutMs));
    try {
      const value = await read(controller.signal);
      if (now() >= options.deadlineAt) throw new ReadDeadlineError();
      return value;
    } catch (error) {
      if (now() >= options.deadlineAt) throw new ReadDeadlineError();
      const transient = controller.signal.aborted
        ? { message: "fetch timed out", code: "READ_TIMEOUT" }
        : transientFetchError(error);
      if (!transient) throw error;
      options.onTransientError?.(transient);
      const retryIn = Math.min(options.retryDelayMs, options.deadlineAt - now());
      if (retryIn <= 0) throw new ReadDeadlineError();
      await sleep(retryIn);
    } finally {
      clearTimeout(timer);
    }
  }
}
