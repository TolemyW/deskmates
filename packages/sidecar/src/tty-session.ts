// Run-owned interactive terminals. The hook remains the sole approval point: open/write are L2.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolFn } from "./deps.js";

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void };
}
export type PtyFactory = (options: {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}) => Promise<PtyProcess>;

const MAX_OUTPUT = 64 * 1024;
const schema = {
  action: z.enum(["open", "read", "write", "resize", "close"]),
  sessionId: z.string().optional(),
  command: z.string().min(1).max(8192).optional(),
  cwd: z.string().optional(),
  data: z.string().max(8192).optional(),
  sensitive: z.boolean().optional(),
  cols: z.number().int().min(10).max(300).optional(),
  rows: z.number().int().min(2).max(100).optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
  waitMs: z.number().int().min(0).max(1000).optional(),
};
const inputSchema = z.object(schema);
interface Session {
  process: PtyProcess;
  output: string;
  dropped: number;
  exitCode?: number;
  closed: boolean;
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
  subscriptions: { dispose(): void }[];
}

export class TtySessions {
  private readonly sessions = new Map<string, Session>();
  private opening = 0;
  private disposed = false;
  constructor(
    private readonly spawn: PtyFactory,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async execute(raw: unknown): Promise<Record<string, unknown>> {
    const input = inputSchema.parse(raw);
    if (this.disposed)
      throw new Error("Terminal owner has ended; open a new session in the new run.");
    let id = input.sessionId;
    if (input.action === "open") {
      if (!input.command) throw new Error("open requires command");
      if (this.sessions.size + this.opening >= 4)
        throw new Error("Close a terminal before opening another (limit 4).");
      const cwd = resolve("/work", input.cwd ?? "/work");
      if (cwd !== "/work" && !cwd.startsWith("/work/")) throw new Error("cwd must be under /work");
      this.opening++;
      let process: PtyProcess;
      try {
        process = await this.spawn({
          command: input.command,
          cwd,
          cols: input.cols ?? 100,
          rows: input.rows ?? 30,
        });
      } finally {
        this.opening--;
      }
      if (this.disposed) {
        process.kill();
        throw new Error("Run ended while opening terminal");
      }
      id = randomUUID();
      const session: Session = {
        process,
        output: "",
        dropped: 0,
        closed: false,
        timedOut: false,
        subscriptions: [],
      };
      this.sessions.set(id, session);
      session.subscriptions.push(
        process.onData((data) => {
          const combined = session.output + data;
          session.dropped += Math.max(0, combined.length - MAX_OUTPUT);
          session.output = combined.slice(-MAX_OUTPUT);
        }),
      );
      session.subscriptions.push(
        process.onExit(({ exitCode }) => {
          session.exitCode = exitCode;
          session.closed = true;
          if (session.timer) clearTimeout(session.timer);
        }),
      );
      if (!session.closed)
        session.timer = setTimeout(
          () => {
            session.timedOut = true;
            this.stop(session);
          },
          (input.timeoutSeconds ?? 120) * 1000,
        );
      session.timer?.unref();
    }
    const session = id ? this.sessions.get(id) : undefined;
    if (!id || !session)
      throw new Error(
        "Unknown terminal. Sessions are local to one run attempt and do not survive approval parking.",
      );
    if (input.action === "write") {
      if (session.closed) throw new Error("Terminal has exited");
      if (input.data === undefined)
        throw new Error("write requires data (use \\r for Enter, \\u0003 for Ctrl-C)");
      session.process.write(input.data);
    } else if (input.action === "resize") {
      if (session.closed) throw new Error("Terminal has exited");
      session.process.resize(input.cols ?? 100, input.rows ?? 30);
    } else if (input.action === "close") {
      this.stop(session);
    }
    if (input.waitMs && !session.closed) await this.sleep(input.waitMs);
    const result = {
      sessionId: id,
      output: session.output,
      droppedCharacters: session.dropped,
      closed: session.closed,
      timedOut: session.timedOut,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    };
    session.output = "";
    session.dropped = 0;
    if (input.action === "close") {
      for (const subscription of session.subscriptions) subscription.dispose();
      this.sessions.delete(id);
    }
    return result;
  }

  private stop(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    if (!session.closed) {
      try {
        session.process.kill();
      } finally {
        session.closed = true;
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      try {
        this.stop(session);
      } catch {
        /* Attempt every child even if one already exited. */
      }
      for (const subscription of session.subscriptions) subscription.dispose();
    }
    this.sessions.clear();
  }
}

function wrapped(text: string): string {
  return `<untrusted source="terminal">\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n</untrusted>`;
}
export function ttySessionTool(
  tool: ToolFn,
  sessions: TtySessions,
  redact: (text: string) => string = (text) => text,
) {
  return tool(
    "tty_session",
    "Run an interactive terminal inside the workspace. open/write require approval. read returns bounded new output, resize changes dimensions, close terminates it. Sessions end with this run attempt; a parked approval closes them. Mark password/token input sensitive=true so it is redacted from approvals and the ledger. Explicit close releases finished session slots. Do not replay a write into another session or bypass a denied browser action.",
    schema,
    async (input) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: wrapped(redact(JSON.stringify(await sessions.execute(input)))),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: wrapped(String(error)) }],
        };
      }
    },
  );
}
