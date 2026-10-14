// A `fetch` that plays the Graph API `messages` endpoint: records every send and answers from a
// programmable queue (default: 200 with a message id).

export interface RecordedSend {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeGraph {
  fetch: typeof fetch;
  sends: RecordedSend[];
  /** Responses consumed in order; when empty, every send succeeds. */
  queue: { status: number; body?: unknown }[];
}

export function createFakeGraph(): FakeGraph {
  const sends: RecordedSend[] = [];
  const queue: FakeGraph["queue"] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    sends.push({
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = queue.shift() ?? {
      status: 200,
      body: { messages: [{ id: `wamid.out.${sends.length}` }] },
    };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, sends, queue };
}
