// A model's reply precedes the store's verdict. Surface writes that are not usable as trusted
// current memory so a conversational "remembered" cannot hide a gate or an excluded update.
// Only outcomes a person can act on or should know about are reported: a gated item waits for
// their confirmation, a refused rule or a write kept as history did not become the current value,
// and an untrusted entry is stored but excluded from automatic context. A `skipped` item is the
// store's deliberate transient-observation filter or a malformed item; it leaves nothing in
// Observations to review, so it stays in the ledger only.
import type { GatewayContext } from "../context.js";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import type { LearnedOutcome } from "./learned-writes.js";

const PREFIX = "Memory update:";

export function publishLearningNotice(
  ctx: GatewayContext,
  run: RunRecord,
  outcomes: readonly LearnedOutcome[],
  published: GatewayEvent[],
): void {
  if (!run.threadId || run.config.runType || run.triggerKind === "model_job") return;
  const counts = { gated: 0, excluded: 0, untrusted: 0 };
  for (const outcome of outcomes) {
    if (outcome.outcome === "gated") counts.gated += 1;
    else if (outcome.outcome === "refused" || outcome.outcome === "history") counts.excluded += 1;
    else if ("entryId" in outcome) {
      const entry = ctx.memory.entries.mustGet(outcome.entryId);
      if (entry.trust === "untrusted" && entry.scope !== "task") counts.untrusted += 1;
    }
  }
  if (!counts.gated && !counts.excluded && !counts.untrusted) return;
  if (
    ctx.messages
      .postedByRun(run.id)
      .some((message) => message.authorKind === "system" && message.body.startsWith(PREFIX))
  )
    return;
  const details = [
    ...(counts.gated ? [`${counts.gated} item(s) need human confirmation.`] : []),
    ...(counts.excluded ? [`${counts.excluded} item(s) were not applied as current memory.`] : []),
    ...(counts.untrusted
      ? [
          `${counts.untrusted} item(s) were saved as untrusted and are excluded from automatic context.`,
        ]
      : []),
  ];
  const { message } = ctx.router.postSystem(
    run.threadId,
    `${PREFIX} ${details.join(" ")} These items are not confirmed saved preferences or facts. Review [Observations](#/knowledge/observations) before relying on them.`,
    [],
    { inert: true, runId: run.id },
  );
  published.push({ type: "thread_message", threadId: run.threadId, message });
}
