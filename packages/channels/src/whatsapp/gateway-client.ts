// The slice of the Gateway operator API the adapter uses (ADR-0017 decision 2), typed against
// contracts. Requests carry the operator credential in the Authorization header; the SSE stream
// carries it in the URL, the one place ADR-0006 allows it.

import type {
  Approval,
  ApprovalDecision,
  Run,
  Thread,
  ThreadMember,
  ThreadMessage,
} from "@deskmates/contracts";

/** The Gateway could not be reached or answered 5xx; the webhook answers 503 so Meta retries. */
export class GatewayUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnavailable";
  }
}

/** A 4xx from the Gateway, with its typed code. */
export class GatewayRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRejected";
  }
}

export interface PostedMessage {
  message: ThreadMessage;
  runs: Run[];
  duplicate?: boolean;
}

/** The SSE frames the adapter reads; other frame types are ignored. */
export type GatewayFrame =
  | { type: "thread_message"; threadId: string; message: ThreadMessage }
  | { type: string; threadId?: string };

export interface GatewayClientOptions {
  baseUrl: string;
  operatorToken: string;
  fetch?: typeof fetch;
}

/** Transport-neutral slice used by the adapter; the in-process plugin wraps ChannelPluginHost. */
export interface ChannelGatewayClient {
  findThread(channel: string, externalKey: string): Promise<Thread | undefined>;
  createThread(input: {
    workspaceId: string;
    botIds: readonly string[];
    channel: string;
    externalKey: string;
    title: string;
  }): Promise<Thread>;
  getThread(id: string): Promise<{ thread: Thread; members: (ThreadMember & { name: string })[] }>;
  postHumanMessage(
    threadId: string,
    body: string,
    authorId: string,
    externalId: string,
  ): Promise<PostedMessage>;
  listMessages(threadId: string, afterSeq: number): Promise<ThreadMessage[]>;
  getApproval(id: string): Promise<Approval | undefined>;
  decideApproval(
    id: string,
    decision: Extract<ApprovalDecision, "allow_once" | "deny">,
    authorId: string,
    reason?: string,
  ): Promise<Approval>;
  subscribe(
    handlers: {
      onFrame: (frame: GatewayFrame) => void | Promise<void>;
      onOpen: () => void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export class GatewayClient implements ChannelGatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.operatorToken;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async findThread(channel: string, externalKey: string): Promise<Thread | undefined> {
    const query = new URLSearchParams({ channel, externalKey });
    const { threads } = await this.request<{ threads: Thread[] }>(
      "GET",
      `/api/threads?${query.toString()}`,
    );
    return threads[0];
  }

  async createThread(input: {
    workspaceId: string;
    botIds: readonly string[];
    channel: string;
    externalKey: string;
    title: string;
  }): Promise<Thread> {
    const { thread } = await this.request<{ thread: Thread }>("POST", "/api/threads", input);
    return thread;
  }

  async getThread(
    id: string,
  ): Promise<{ thread: Thread; members: (ThreadMember & { name: string })[] }> {
    return this.request("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  async postHumanMessage(
    threadId: string,
    body: string,
    authorId: string,
    externalId: string,
  ): Promise<PostedMessage> {
    return this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, {
      body,
      authorId,
      externalId,
    });
  }

  async listMessages(threadId: string, afterSeq: number): Promise<ThreadMessage[]> {
    const { messages } = await this.request<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/messages?afterSeq=${afterSeq}`,
    );
    return messages;
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    try {
      const { approval } = await this.request<{ approval: Approval }>(
        "GET",
        `/api/approvals/${encodeURIComponent(id)}`,
      );
      return approval;
    } catch (err) {
      if (err instanceof GatewayRejected && err.status === 404) return undefined;
      throw err;
    }
  }

  async decideApproval(
    id: string,
    decision: Extract<ApprovalDecision, "allow_once" | "deny">,
    authorId: string,
    reason?: string,
  ): Promise<Approval> {
    const { approval } = await this.request<{ approval: Approval }>(
      "POST",
      `/api/approvals/${encodeURIComponent(id)}/decide`,
      { decision, authorId, ...(reason ? { reason } : {}) },
    );
    return approval;
  }

  /**
   * Read `GET /api/events` until `signal` aborts, reconnecting with backoff. `onOpen` fires on
   * every successful connection, first and later alike, so the caller can refetch what a gap
   * may have hidden (ADR-0017 decision 6).
   */
  async subscribe(
    handlers: {
      onFrame: (frame: GatewayFrame) => void | Promise<void>;
      onOpen: () => void | Promise<void>;
    },
    signal: AbortSignal,
    backoff: { initialMs: number; maxMs: number } = { initialMs: 500, maxMs: 15_000 },
  ): Promise<void> {
    let delay = backoff.initialMs;
    while (!signal.aborted) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/events`,
          // The Gateway accepts the operator credential only in the header, never in a URL
          // (ADR-0022 decision 4).
          {
            headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` },
            signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new GatewayUnavailable(`events stream answered ${response.status}`);
        }
        delay = backoff.initialMs;
        await handlers.onOpen();
        await readSse(response.body, handlers.onFrame);
      } catch (err) {
        if (signal.aborted) return;
        void err;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new GatewayUnavailable(err instanceof Error ? err.message : String(err));
    }
    const text = await response.text();
    if (response.status >= 500)
      throw new GatewayUnavailable(`${method} ${path} answered ${response.status}`);
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed ?? {}) as { code?: string; message?: string };
      throw new GatewayRejected(
        response.status,
        error.code ?? "unknown",
        error.message ?? `${method} ${path} failed with ${response.status}`,
      );
    }
    return parsed as T;
  }
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: GatewayFrame) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) {
        let frame: GatewayFrame | undefined;
        try {
          frame = JSON.parse(data) as GatewayFrame;
        } catch {
          frame = undefined;
        }
        if (frame && typeof frame.type === "string") await onFrame(frame);
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}
