// SOUL proposals (issue #77; ADR-0023 amendment 1, decision 10). Generating one is a cheap-model
// run of the bot being edited; its text is stored here as a proposal and nothing else changes.
// For an edit the model returns find-and-replace operations that this module applies to the base
// it was given, so text outside the requested spans stays byte-identical. Applying is a separate,
// explicit act in the route, through the canonical SOUL write and its version check.

import {
  type BotDefinition,
  DeskmatesError,
  type RunEnded,
  type SoulEdit,
  type SoulProposal,
  type SoulProposalMode,
  type SoulProposalStatus,
  applySoulEdits,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { RunRecord } from "../ledger/runs.js";
import { modelsForJob } from "../scheduler/job-models.js";

export const SOUL_PROPOSAL = "soul_proposal";
const SOUL_MAX_BYTES = 65536;

interface ProposalRow {
  id: string;
  workspace_id: string;
  bot_id: string;
  mode: SoulProposalMode;
  instruction: string;
  base_version: string;
  base_body: string;
  status: SoulProposalStatus;
  proposed_body: string | null;
  run_id: string | null;
  error: string | null;
  applied_version: string | null;
  requested_by: string;
  created_at: string;
  finished_at: string | null;
}

function view(row: ProposalRow): SoulProposal {
  return {
    id: row.id,
    botId: row.bot_id,
    mode: row.mode,
    instruction: row.instruction,
    status: row.status,
    baseVersion: row.base_version,
    baseBody: row.base_body,
    proposedBody: row.proposed_body,
    runId: row.run_id,
    error: row.error,
    appliedVersion: row.applied_version,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** A model reply without the code fence a model sometimes wraps it in. */
function unfenced(text: string): string {
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return (fenced ? (fenced[1] as string) : text).trim();
}

/** Parse an edit reply: one JSON object with `edits` and an optional `append`. */
export function parseSoulEdits(reply: string): { edits: SoulEdit[]; append?: string } | undefined {
  const text = unfenced(reply);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as { edits?: unknown; append?: unknown };
  const raw = value.edits ?? [];
  if (!Array.isArray(raw)) return undefined;
  const edits: SoulEdit[] = [];
  for (const item of raw) {
    const edit = item as { find?: unknown; replace?: unknown };
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") return undefined;
    edits.push({ find: edit.find, replace: edit.replace });
  }
  if (value.append !== undefined && typeof value.append !== "string") return undefined;
  return { edits, ...(typeof value.append === "string" ? { append: value.append } : {}) };
}

/** The proposed body for a finished job, or why there is none. */
export function proposedBody(
  mode: SoulProposalMode,
  base: string,
  reply: string,
): { ok: true; body: string } | { ok: false; error: string } {
  let body: string;
  if (mode === "create") {
    body = unfenced(reply);
    if (body === "") return { ok: false, error: "The model returned no SOUL text" };
    body = `${body}\n`;
  } else {
    const parsed = parseSoulEdits(reply);
    if (!parsed) return { ok: false, error: "The model did not return targeted edits" };
    const applied = applySoulEdits(base, parsed.edits, parsed.append);
    if (!applied.ok)
      return {
        ok: false,
        error:
          applied.error === "no_edits"
            ? "The model proposed no change"
            : `The model's edit did not match the current SOUL exactly once (${applied.error})`,
      };
    body = applied.body;
  }
  if (body === base) return { ok: false, error: "The model proposed no change" };
  if (Buffer.byteLength(body) > SOUL_MAX_BYTES)
    return { ok: false, error: "The proposed SOUL is too long" };
  return { ok: true, body };
}

export class SoulProposals {
  constructor(private readonly ctx: GatewayContext) {}

  get(id: string): SoulProposal | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM soul_proposals WHERE id = ?").get(id) as
      | ProposalRow
      | undefined;
    return row ? view(row) : undefined;
  }

  mustGetForBot(id: string, botId: string): SoulProposal {
    const proposal = this.get(id);
    if (!proposal || proposal.botId !== botId)
      throw new DeskmatesError("not_found", "no such SOUL proposal for this bot", { id });
    return proposal;
  }

  /**
   * Queue a generation against the given base. A pending proposal of this bot is returned instead
   * of starting a second one, so a repeated submission creates nothing.
   */
  create(input: {
    bot: BotDefinition;
    instruction: string;
    base: { body: string; version: string };
    requestedBy: string;
  }): { proposal: SoulProposal; run?: RunRecord } {
    const { bot } = input;
    return this.ctx.db.transaction(() => {
      const pending = this.ctx.db
        .prepare("SELECT * FROM soul_proposals WHERE bot_id = ? AND status = 'pending'")
        .get(bot.id) as ProposalRow | undefined;
      if (pending) return { proposal: view(pending) };
      // The same request against the same SOUL is answered by the proposal it already produced.
      const same = this.ctx.db
        .prepare(
          `SELECT * FROM soul_proposals WHERE workspace_id = ? AND bot_id = ? AND status = 'ready'
              AND instruction = ? AND base_version = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(bot.workspaceId, bot.id, input.instruction, input.base.version) as
        | ProposalRow
        | undefined;
      if (same) return { proposal: view(same) };
      const id = newId("soulp");
      const mode: SoulProposalMode = input.base.body.trim() === "" ? "create" : "edit";
      const run = this.ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `${SOUL_PROPOSAL}:${id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...this.ctx.runConfig(),
          runType: SOUL_PROPOSAL,
          soulProposalId: id,
          ...modelsForJob(SOUL_PROPOSAL, bot.cheapModel ?? this.ctx.config.cheapModel),
          fallbackModel: null,
          maxTurns: 1,
          soulProposalVersion: 1,
        },
      });
      this.ctx.db
        .prepare(
          `INSERT INTO soul_proposals
             (id, workspace_id, bot_id, mode, instruction, base_version, base_body, status, run_id,
              requested_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          bot.workspaceId,
          bot.id,
          mode,
          input.instruction,
          input.base.version,
          input.base.body,
          run.id,
          input.requestedBy,
          new Date().toISOString(),
        );
      return { proposal: this.get(id) as SoulProposal, run };
    })();
  }

  /** The job the sidecar runs for a proposal run; built at start from the stored request. */
  job(run: RunRecord, bot: BotDefinition) {
    const proposal = this.get(String(run.config.soulProposalId ?? ""));
    if (!proposal) return undefined;
    return {
      kind: "soul_proposal" as const,
      mode: proposal.mode,
      botName: bot.name,
      role: bot.role,
      instruction: proposal.instruction,
      baseBody: proposal.baseBody,
    };
  }

  /** Store the job's result; a discarded proposal stays discarded. Returns the run's status. */
  complete(run: RunRecord, ended: RunEnded): "succeeded" | "failed" {
    const proposal = this.get(String(run.config.soulProposalId ?? ""));
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "") : "";
    const now = new Date().toISOString();
    if (!proposal || proposal.runId !== run.id) return reply ? "succeeded" : "failed";
    const result = reply
      ? proposedBody(proposal.mode, proposal.baseBody, reply)
      : { ok: false as const, error: ended.error ?? "The generation did not finish" };
    this.ctx.db
      .prepare(
        `UPDATE soul_proposals SET status = ?, proposed_body = ?, error = ?, finished_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(
        result.ok ? "ready" : "failed",
        result.ok ? result.body : null,
        result.ok ? null : result.error.slice(0, 500),
        now,
        proposal.id,
      );
    return reply ? "succeeded" : "failed";
  }

  discard(proposal: SoulProposal, by: string): SoulProposal {
    if (proposal.status === "applied")
      throw new DeskmatesError("invalid_transition", "an applied proposal cannot be discarded");
    this.ctx.db
      .prepare(
        `UPDATE soul_proposals SET status = 'discarded', decided_by = ?, decided_at = ?
          WHERE id = ? AND status IN ('pending', 'ready', 'failed')`,
      )
      .run(by, new Date().toISOString(), proposal.id);
    return this.get(proposal.id) as SoulProposal;
  }

  /** Called inside the apply transaction, after the canonical write succeeded. */
  markApplied(proposal: SoulProposal, version: string, by: string): SoulProposal {
    this.ctx.db
      .prepare(
        `UPDATE soul_proposals SET status = 'applied', applied_version = ?, decided_by = ?,
           decided_at = ? WHERE id = ? AND status = 'ready'`,
      )
      .run(version, by, new Date().toISOString(), proposal.id);
    return this.get(proposal.id) as SoulProposal;
  }
}
