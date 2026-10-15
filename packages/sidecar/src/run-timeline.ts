// The sidecar's half of the run startup timeline (ADR-0037 decision 1): when this process
// started, when it called `query()`, when the SDK initialized, and the first stream event, first
// token and first text of the top-level conversation. Each mark is recorded once per process;
// subagent streams (`parent_tool_use_id` set) do not count. Observations never fail a run.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type RunTimelineMark, timelineMark } from "@deskmates/contracts";

export type TimelineEmit = (payload: Record<string, unknown>) => void;

export class SidecarTimeline {
  private readonly seen = new Set<RunTimelineMark>();

  constructor(
    private readonly emit: TimelineEmit,
    private readonly now: () => Date,
  ) {}

  mark(name: RunTimelineMark, attributes: Record<string, unknown> = {}): void {
    if (this.seen.has(name)) return;
    this.seen.add(name);
    try {
      this.emit({ ...timelineMark(name, this.now(), attributes) });
    } catch {
      // Timing is observational; a ledger failure never reaches the run.
    }
  }

  /** Reads one SDK message for the marks it can carry; never changes how the run handles it. */
  observe(msg: SDKMessage): void {
    if (msg.type === "stream_event") {
      if (msg.parent_tool_use_id !== null) return;
      const event = msg.event;
      this.mark(
        "first_stream_event",
        typeof msg.ttft_ms === "number" ? { sdkTtftMs: msg.ttft_ms } : {},
      );
      if (event.type === "content_block_delta") {
        this.mark("first_token", { deltaType: event.delta.type });
        if (event.delta.type === "text_delta" && event.delta.text !== "") this.mark("first_text");
      }
      return;
    }
    if (msg.type === "system" && msg.subtype === "init") {
      this.mark("sdk_init", {
        mcpServers: msg.mcp_servers.map(({ name, status }) => ({ name, status })),
      });
      return;
    }
    if (msg.type === "result") {
      const extra = msg as unknown as Record<string, unknown>;
      const optional = (key: string, as: string): Record<string, number> =>
        typeof extra[key] === "number" ? { [as]: extra[key] as number } : {};
      this.mark("sdk_result", {
        subtype: msg.subtype,
        numTurns: msg.num_turns,
        durationApiMs: msg.duration_api_ms,
        // Present on SDK 0.3.278's success result; undocumented there, so recorded verbatim.
        ...optional("ttft_ms", "ttftMs"),
        ...optional("ttft_stream_ms", "ttftStreamMs"),
        ...optional("time_to_request_ms", "timeToRequestMs"),
      });
    }
  }
}

/** When this OS process started, from its own uptime. */
export function processStartedAt(now: Date, uptimeSeconds: number): Date {
  return new Date(now.getTime() - Math.max(0, uptimeSeconds) * 1000);
}
