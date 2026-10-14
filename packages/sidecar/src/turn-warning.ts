// ADR-0016: one host-authored handoff warning per process when five model responses remain.
// The SDK emits one assistant message per content block, so count distinct response ids.

export class TurnWarning {
  private readonly responses = new Set<string>();
  private warned = false;

  /** `null` is the workspace's `off` (ADR-0016 amendment 2): no cap, so never a warning. */
  constructor(private readonly maxTurns: number | null) {}

  observeAssistant(id: string): void {
    this.responses.add(id);
  }

  afterTool(): string | undefined {
    if (this.maxTurns === null) return undefined;
    if (this.warned || this.maxTurns - this.responses.size > 5) return undefined;
    this.warned = true;
    const remaining = Math.max(0, this.maxTurns - this.responses.size);
    return `Turn budget warning: ${remaining} assistant turns remain in this attempt. Save partial results now in /work and write a handoff file under /work describing completed work, remaining work, and file paths. If you are using a shared work board, update it. Include the handoff path in your final summary.`;
  }
}
