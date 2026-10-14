// A stand-in for the Gateway operator routes the adapter uses (ADR-0017 decision 2), on a real
// loopback port so the client's HTTP and SSE code is exercised. The route shapes mirror
// packages/gateway/src/api/thread-routes.ts and approval-routes.ts; the Gateway-side T1 test
// `thread-channel-routes.test.ts` proves the real routes behave the same way.

import { type Server, type ServerResponse, createServer } from "node:http";
import type { Approval, Attachment, Thread, ThreadMessage } from "@deskmates/contracts";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface Member {
  threadId: string;
  botId: string;
  name: string;
  lastSeenSeq: number;
  joinedAt: string;
}

export interface FakeGateway {
  baseUrl: string;
  token: string;
  requests: RecordedRequest[];
  /** When true every request answers 503 (the Gateway is "down"). */
  unavailable: boolean;
  bots: Map<string, string>;
  threads(): Thread[];
  messages(threadId: string): ThreadMessage[];
  decisions: { approvalId: string; decision: string; authorId: string; reason?: string }[];
  addBot(id: string, name: string): void;
  addApproval(approval: Approval): void;
  /** Append a bot or system message as the Gateway would and publish its SSE frame. */
  append(
    threadId: string,
    message: Pick<ThreadMessage, "authorKind" | "authorId" | "body"> & {
      attachments?: Attachment[];
    },
  ): ThreadMessage;
  close(): Promise<void>;
}

export async function startFakeGateway(token = "operator-token"): Promise<FakeGateway> {
  const threads = new Map<string, Thread>();
  const members = new Map<string, Member[]>();
  const messages = new Map<string, ThreadMessage[]>();
  const approvals = new Map<string, Approval>();
  const bots = new Map<string, string>();
  const streams = new Set<ServerResponse>();
  const requests: RecordedRequest[] = [];
  const decisions: FakeGateway["decisions"] = [];
  let counter = 0;
  const state = { unavailable: false };
  const now = () => new Date().toISOString();

  const publish = (threadId: string, message: ThreadMessage): void => {
    const frame = JSON.stringify({ type: "thread_message", threadId, message });
    for (const res of streams) res.write(`event: thread_message\ndata: ${frame}\n\n`);
  };

  const append: FakeGateway["append"] = (threadId, input) => {
    const list = messages.get(threadId);
    if (!list) throw new Error(`fake gateway: no thread ${threadId}`);
    const message: ThreadMessage = {
      id: `msg_${++counter}` as ThreadMessage["id"],
      threadId: threadId as ThreadMessage["threadId"],
      seq: list.length + 1,
      authorKind: input.authorKind,
      authorId: input.authorId,
      body: input.body,
      attachments: input.attachments ?? [],
      mentions: [],
      relayCount: 0,
      ts: now(),
    };
    list.push(message);
    publish(threadId, message);
    return message;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (state.unavailable) return json(res, 503, { code: "unavailable", message: "down" });
      const auth = req.headers.authorization;
      // Like the Gateway, a credential in the URL is refused (ADR-0022 decision 4).
      if (auth !== `Bearer ${token}` || url.searchParams.has("token")) {
        return json(res, 401, { code: "token_rejected", message: "no credential" });
      }
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": connected\n\n");
        streams.add(res);
        // The request's own 'close' fires once its (empty) body is consumed; the response's
        // 'close' is the connection going away.
        res.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/threads") {
        const channel = url.searchParams.get("channel");
        const key = url.searchParams.get("externalKey");
        const list = [...threads.values()].filter(
          (t) =>
            (channel === null || t.channel === channel) && (key === null || t.externalKey === key),
        );
        return json(res, 200, { threads: list });
      }
      if (req.method === "POST" && url.pathname === "/api/threads") {
        const input = body as {
          workspaceId: string;
          botIds: string[];
          channel?: string;
          externalKey?: string;
          title?: string;
        };
        const existing = input.externalKey
          ? [...threads.values()].find(
              (t) => t.channel === (input.channel ?? "web") && t.externalKey === input.externalKey,
            )
          : undefined;
        if (existing)
          return json(res, 200, { thread: existing, members: members.get(existing.id) });
        const id = `thr_${++counter}`;
        const thread: Thread = {
          id: id as Thread["id"],
          workspaceId: input.workspaceId as Thread["workspaceId"],
          kind: "chat",
          channel: input.channel ?? "web",
          ...(input.externalKey ? { externalKey: input.externalKey } : {}),
          title: input.title ?? input.botIds.join(", "),
          turnBudget: 8,
          status: "active",
          createdAt: now(),
          updatedAt: now(),
        };
        threads.set(id, thread);
        members.set(
          id,
          input.botIds.map((botId) => ({
            threadId: id,
            botId,
            name: bots.get(botId) ?? botId,
            lastSeenSeq: 0,
            joinedAt: now(),
          })),
        );
        messages.set(id, []);
        return json(res, 201, { thread, members: members.get(id) });
      }
      if (parts[0] === "api" && parts[1] === "threads" && parts[2]) {
        const thread = threads.get(parts[2]);
        if (!thread) return json(res, 404, { code: "not_found", message: "thread" });
        if (req.method === "GET" && parts.length === 3) {
          return json(res, 200, { thread, members: members.get(thread.id) });
        }
        if (parts[3] === "messages" && req.method === "GET") {
          const after = Number(url.searchParams.get("afterSeq") ?? "0");
          return json(res, 200, {
            messages: (messages.get(thread.id) ?? []).filter((m) => m.seq > after),
          });
        }
        if (parts[3] === "messages" && req.method === "POST") {
          const input = body as { body: string; authorId?: string; externalId?: string };
          const list = messages.get(thread.id) ?? [];
          const dup = input.externalId
            ? list.find((m) => m.externalId === input.externalId)
            : undefined;
          if (dup) return json(res, 200, { message: dup, runs: [], duplicate: true });
          const message: ThreadMessage = {
            id: `msg_${++counter}` as ThreadMessage["id"],
            threadId: thread.id,
            seq: list.length + 1,
            authorKind: "human",
            authorId: input.authorId ?? "web",
            body: input.body,
            attachments: [],
            mentions: [],
            relayCount: 0,
            ...(input.externalId ? { externalId: input.externalId } : {}),
            ts: now(),
          };
          list.push(message);
          publish(thread.id, message);
          return json(res, 201, {
            message,
            runs: [{ id: `run_${++counter}`, botId: members.get(thread.id)?.[0]?.botId }],
          });
        }
      }
      if (parts[0] === "api" && parts[1] === "approvals" && parts[2]) {
        const approval = approvals.get(parts[2]);
        if (!approval) return json(res, 404, { code: "not_found", message: "approval" });
        if (req.method === "GET") return json(res, 200, { approval });
        if (req.method === "POST" && parts[3] === "decide") {
          if (approval.decision) {
            return json(res, 409, { code: "invalid_transition", message: "already decided" });
          }
          const input = body as { decision: string; authorId: string; reason?: string };
          decisions.push({ approvalId: approval.id, ...input });
          const decided: Approval = {
            ...approval,
            decision: input.decision as NonNullable<Approval["decision"]>,
            decidedBy: `human:${input.authorId}`,
            decidedAt: now(),
          };
          approvals.set(approval.id, decided);
          return json(res, 200, { approval: decided });
        }
      }
      return json(res, 404, {
        code: "not_found",
        message: `no route ${req.method} ${url.pathname}`,
      });
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    get unavailable() {
      return state.unavailable;
    },
    set unavailable(value: boolean) {
      state.unavailable = value;
    },
    bots,
    threads: () => [...threads.values()],
    messages: (threadId) => [...(messages.get(threadId) ?? [])],
    decisions,
    addBot: (id, name) => {
      bots.set(id, name);
    },
    addApproval: (approval) => {
      approvals.set(approval.id, approval);
    },
    append,
    close: async () => {
      for (const res of streams) res.end();
      streams.clear();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
