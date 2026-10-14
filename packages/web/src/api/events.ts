// Subscription to `GET /api/events` (server-sent events). Dispatches `run_status`, `run_event`
// and `thread_message` frames as typed `GatewayEvent`s. The browser's EventSource retries on
// transient errors by itself; when it gives up (readyState CLOSED) we reopen it with backoff.
//
// A reopened stream does not replay what it missed: the Gateway fans out live frames only. So the
// subscription reports every reconnecting → open transition through `onReconnect`, and the screen
// re-runs its initial fetch and merges the result to recover the gap.

import { GATEWAY_EVENT_TYPES, type GatewayEvent } from "./types.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface SubscribeOptions {
  threadId?: string;
  onEvent: (event: GatewayEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /**
   * Called on every reconnecting → open transition, never on the first open. Frames emitted while
   * the stream was down are gone, so the caller must refetch and merge.
   */
  onReconnect?: () => void;
  /** Injected in tests; defaults to the global `EventSource`. */
  EventSource?: typeof EventSource;
  baseUrl?: string;
  /** First reconnect delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

let streamTenant: string | undefined;

/**
 * The tenant this tab's streams are opened in (ADR-0022 P4). The app sets it before mounting a
 * tenant's screens; streams already open keep the tenant they were opened with and close when
 * those screens unmount.
 */
export function setStreamTenant(tenantId: string | undefined): void {
  streamTenant = tenantId;
}

/**
 * The stream URL. It never carries a credential: the browser's same-origin EventSource sends the
 * HttpOnly session cookie (ADR-0022 decision 4).
 */
export function eventsUrl(threadId: string | undefined, baseUrl = ""): string {
  const query = new URLSearchParams();
  if (threadId) query.set("threadId", threadId);
  // EventSource cannot send the tenant header; the Gateway reads the same selector here.
  if (streamTenant) query.set("tenant", streamTenant);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `${baseUrl}/api/events${suffix}`;
}

export function parseGatewayEvent(data: string): GatewayEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !(GATEWAY_EVENT_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }
  return parsed as GatewayEvent;
}

const CLOSED = 2;

interface SharedConnection {
  listeners: Set<SubscribeOptions>;
  status: ConnectionStatus;
  stop: () => void;
}

// One connection per URL, constructor and retry policy in this browser tab.
const connections = new Map<typeof EventSource, Map<string, SharedConnection>>();

function notify<T>(
  listeners: Set<SubscribeOptions>,
  callback: (listener: SubscribeOptions) => T,
): void {
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    try {
      callback(listener);
    } catch {
      // A screen's callback must not prevent other subscribers from seeing the same frame.
    }
  }
}

/** Subscribe to a pooled stream. The last unsubscribe closes it and cancels its reconnect timer. */
export function subscribeEvents(options: SubscribeOptions): () => void {
  const listener = { ...options };
  const Ctor = options.EventSource ?? globalThis.EventSource;
  const url = eventsUrl(options.threadId, options.baseUrl);
  const key = JSON.stringify([url, options.backoffMs ?? 1000, options.maxBackoffMs ?? 10_000]);
  let byKey = connections.get(Ctor);
  if (!byKey) {
    byKey = new Map();
    connections.set(Ctor, byKey);
  }
  let connection = byKey.get(key);
  if (!connection) {
    connection = { listeners: new Set(), status: "connecting", stop: () => {} };
    byKey.set(key, connection);
    connection.listeners.add(listener);
    const shared = connection;
    shared.stop = openConnection({
      ...options,
      EventSource: Ctor,
      onEvent: (event) => notify(shared.listeners, (listener) => listener.onEvent(event)),
      onStatus: (status) => {
        shared.status = status;
        notify(shared.listeners, (listener) => listener.onStatus?.(status));
      },
      onReconnect: () => notify(shared.listeners, (listener) => listener.onReconnect?.()),
    });
  } else {
    connection.listeners.add(listener);
    try {
      options.onStatus?.(connection.status);
    } catch {
      // The new listener still receives future frames and does not affect existing listeners.
    }
  }
  const shared = connection;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    shared.listeners.delete(listener);
    if (shared.listeners.size > 0) return;
    byKey.delete(key);
    if (byKey.size === 0) connections.delete(Ctor);
    shared.stop();
  };
}

/** Own one physical EventSource and its reconnect timer. */
function openConnection(options: SubscribeOptions): () => void {
  const Ctor = options.EventSource ?? globalThis.EventSource;
  const url = eventsUrl(options.threadId, options.baseUrl);
  const firstBackoff = options.backoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 10_000;

  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = firstBackoff;
  let stopped = false;
  let status: ConnectionStatus = "connecting";

  const setStatus = (next: ConnectionStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  const onFrame = (e: Event): void => {
    const event = parseGatewayEvent((e as MessageEvent<string>).data);
    if (event) options.onEvent(event);
  };

  const open = (): void => {
    if (stopped) return;
    setStatus(source === undefined ? "connecting" : "reconnecting");
    const es = new Ctor(url);
    source = es;
    for (const type of GATEWAY_EVENT_TYPES) es.addEventListener(type, onFrame);
    es.onopen = () => {
      // The browser reconnects transient drops on its own, so a gap shows up here and not in
      // `onerror`: any open that follows a "reconnecting" status may have missed frames.
      const recovered = status === "reconnecting";
      backoff = firstBackoff;
      setStatus("open");
      if (recovered && !stopped) options.onReconnect?.();
    };
    es.onerror = () => {
      if (stopped) return;
      if (es.readyState === CLOSED) {
        es.close();
        setStatus("reconnecting");
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      } else {
        // EventSource is retrying on its own.
        setStatus("reconnecting");
      }
    };
  };

  open();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    source?.close();
  };
}
