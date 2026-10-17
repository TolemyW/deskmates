// What the CLI itself puts in the context window, per category (issue #8, ADR-0023 amendment 5).
// The sidecar's own `context_sections` event measures only the text it assembles; the CLI adds
// its built-in prompt, every built-in tool schema, the MCP tool schemas and the skill listing,
// and only the CLI can say how large those are. `query.getContextUsage()` (SDK 0.3.278) asks it.
//
// One `full` sample right after `system/init` gives the per-category breakdown once per attempt;
// one `summary` sample after each model response follows the window's growth without the
// token-count calls a `full` sample makes. Every sample is a `log` event `{source: "context",
// kind: "context_usage"}`. Observability only: a failed or missing answer costs one warning and
// stops later samples, never the run, and nothing here changes what the model is sent.

import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

export type ContextUsageDetail = "summary" | "full";

/** The part of the SDK's answer the sidecar records; the real response is assignable to it. */
export type ContextUsageReport = Pick<
  SDKControlGetContextUsageResponse,
  | "categories"
  | "totalTokens"
  | "maxTokens"
  | "rawMaxTokens"
  | "percentage"
  | "model"
  | "memoryFiles"
  | "mcpTools"
  | "systemTools"
  | "systemPromptSections"
  | "skills"
  | "messageBreakdown"
>;

/** `Query.getContextUsage` as the sidecar calls it; absent on a query that does not offer it. */
export interface ContextUsageSource {
  getContextUsage?: (opts?: { detail?: ContextUsageDetail }) => Promise<ContextUsageReport>;
}

function sum(items: readonly { tokens: number }[]): number {
  return items.reduce((n, item) => n + item.tokens, 0);
}

/**
 * The ledger payload of one sample. A `full` sample names each built-in and MCP tool with its
 * tokens, which is what a trimming decision needs; a `summary` sample keeps only the totals.
 */
export function contextUsagePayload(
  report: ContextUsageReport,
  detail: ContextUsageDetail,
  turn: number,
): Record<string, unknown> {
  const byServer: Record<string, number> = {};
  for (const tool of report.mcpTools) {
    byServer[tool.serverName] = (byServer[tool.serverName] ?? 0) + tool.tokens;
  }
  return {
    source: "context",
    kind: "context_usage",
    detail,
    turn,
    model: report.model,
    totalTokens: report.totalTokens,
    maxTokens: report.maxTokens,
    rawMaxTokens: report.rawMaxTokens,
    percentage: report.percentage,
    categories: report.categories.map(({ name, kind, tokens }) => ({ name, kind, tokens })),
    mcpTools: {
      count: report.mcpTools.length,
      tokens: sum(report.mcpTools),
      byServer,
      ...(detail === "full"
        ? { tools: report.mcpTools.map(({ name, tokens }) => ({ name, tokens })) }
        : {}),
    },
    ...(report.systemTools
      ? {
          systemTools: {
            count: report.systemTools.length,
            tokens: sum(report.systemTools),
            ...(detail === "full"
              ? { tools: report.systemTools.map(({ name, tokens }) => ({ name, tokens })) }
              : {}),
          },
        }
      : {}),
    ...(report.systemPromptSections && detail === "full"
      ? {
          systemPromptSections: report.systemPromptSections.map(({ name, tokens }) => ({
            name,
            tokens,
          })),
        }
      : {}),
    memoryFiles: { count: report.memoryFiles.length, tokens: sum(report.memoryFiles) },
    ...(report.skills
      ? {
          skills: {
            total: report.skills.totalSkills,
            included: report.skills.includedSkills,
            tokens: report.skills.tokens,
          },
        }
      : {}),
    ...(report.messageBreakdown
      ? {
          messages: {
            toolCallTokens: report.messageBreakdown.toolCallTokens,
            toolResultTokens: report.messageBreakdown.toolResultTokens,
            attachmentTokens: report.messageBreakdown.attachmentTokens,
            assistantMessageTokens: report.messageBreakdown.assistantMessageTokens,
            userMessageTokens: report.messageBreakdown.userMessageTokens,
          },
        }
      : {}),
  };
}

/** How long the end of a run waits for samples still in flight. */
export const CONTEXT_USAGE_SETTLE_MS = 2000;

/**
 * Asks the query for samples without holding up the message loop: each request runs on its own
 * and `settle()` waits for the ones still pending when the query has ended.
 */
export class ContextUsageProbe {
  private source: ContextUsageSource | undefined;
  private failed = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly emit: (payload: Record<string, unknown>) => void,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  attach(source: ContextUsageSource): void {
    this.source = source;
  }

  /**
   * No more samples: called when the result arrives, because with a string prompt the CLI exits
   * after its result and a control request sent then could only fail.
   */
  detach(): void {
    this.source = undefined;
  }

  sample(detail: ContextUsageDetail, turn: number): void {
    const ask = this.source?.getContextUsage;
    if (this.failed || ask === undefined) return;
    const done = (async () => {
      try {
        const report = await ask.call(this.source, { detail });
        this.emit(contextUsagePayload(report, detail, turn));
      } catch (err) {
        if (this.failed) return;
        this.failed = true;
        this.emit({
          source: "context",
          kind: "context_usage",
          level: "warn",
          detail,
          turn,
          error: String(err).slice(0, 500),
        });
      }
    })();
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
  }

  async settle(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      this.sleep(CONTEXT_USAGE_SETTLE_MS),
    ]);
  }
}
