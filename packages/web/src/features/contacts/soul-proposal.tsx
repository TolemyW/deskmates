// Drafting SOUL.md with AI (issue #77): one sentence or a few keywords in, a proposal out, shown
// as the exact change against the version that was loaded. Generating writes nothing; only the
// explicit apply does, through the same version-checked SOUL write as a hand edit. A proposal
// generated against an older version is refused at apply and must be generated again.

import type { BotDefinition, SoulProposal } from "@deskmates/contracts";
import { diffSoulLines } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError, type MemoryView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";

const POLL_MS = 1000;

export function SoulDiff({ before, after }: { before: string; after: string }) {
  const t = useT();
  const lines = diffSoulLines(before, after);
  return (
    <pre className="soul-diff" aria-label={t("management.soulDraft.diffLabel")}>
      {lines.map((line, index) => (
        <span
          // Lines are positional; the diff is recomputed whole on every change.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff lines
          key={index}
          className={`soul-diff-line soul-diff-${line.kind}`}
          data-kind={line.kind}
        >
          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
          {line.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/**
 * The draft-with-AI panel. `loadedVersion` is the SOUL version the screen shows; a proposal made
 * against another version is flagged before apply. `disabled` holds the panel while the screen has
 * unsaved edits of its own, so a draft never replaces work the operator has not saved.
 */
export function SoulProposalPanel({
  api,
  bot,
  loadedVersion,
  disabled = false,
  initialInstruction = "",
  autoStart = false,
  onApplied,
}: {
  api: ApiClient;
  bot: BotDefinition;
  loadedVersion: string;
  disabled?: boolean;
  initialInstruction?: string;
  autoStart?: boolean;
  onApplied: (soul: MemoryView) => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState(initialInstruction);
  const [proposal, setProposal] = useState<SoulProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);

  const generate = async (text: string) => {
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      setProposal(await api.proposeSoul(bot.id, text.trim()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: start once, on mount, when asked to
  useEffect(() => {
    if (autoStart && initialInstruction.trim()) void generate(initialInstruction);
  }, []);

  const pendingId = proposal?.status === "pending" ? proposal.id : undefined;
  useEffect(() => {
    if (!pendingId) return;
    let active = true;
    const timer = setInterval(() => {
      api
        .getSoulProposal(bot.id, pendingId)
        .then((next) => {
          if (active && next.status !== "pending") setProposal(next);
        })
        .catch((err: unknown) => {
          if (active) setError(errorMessage(err));
        });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, bot.id, pendingId]);

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const applied = await api.applySoulProposal(bot.id, proposal.id);
      setProposal(applied.proposal);
      onApplied(applied.soul);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      await api.discardSoulProposal(bot.id, proposal.id);
      setProposal(undefined);
      setConflict(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const stale = proposal?.status === "ready" && proposal.baseVersion !== loadedVersion;
  return (
    <section className="soul-draft" aria-label={t("management.soulDraft.title")}>
      <h4>{t("management.soulDraft.title")}</h4>
      <p className="muted small">{t("management.soulDraft.intro")}</p>
      <label>
        {t("management.soulDraft.instruction")}
        <input
          value={instruction}
          maxLength={2000}
          disabled={disabled || busy || proposal?.status === "pending"}
          placeholder={t("management.soulDraft.instructionPlaceholder")}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      {disabled ? <p className="muted small">{t("management.soulDraft.saveFirst")}</p> : null}
      <Button
        type="button"
        disabled={
          disabled ||
          busy ||
          !instruction.trim() ||
          proposal?.status === "pending" ||
          proposal?.status === "ready"
        }
        onClick={() => void generate(instruction)}
      >
        {t("management.soulDraft.generate")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {proposal?.status === "pending" ? <output>{t("management.soulDraft.pending")}</output> : null}
      {proposal?.status === "failed" ? (
        <p role="alert">{t("management.soulDraft.failed", { error: proposal.error ?? "" })}</p>
      ) : null}
      {proposal?.status === "ready" && proposal.proposedBody !== null ? (
        <div className="soul-draft-preview">
          <p className="muted small">{t("management.soulDraft.previewIntro")}</p>
          {stale || conflict ? <p role="alert">{t("management.soulDraft.stale")}</p> : null}
          <SoulDiff before={proposal.baseBody} after={proposal.proposedBody} />
          <p className="muted small">{t("management.soulDraft.noPermissions")}</p>
          <div className="settings-actions">
            <Button
              type="button"
              variant="default"
              disabled={busy || stale || conflict}
              onClick={() => void apply()}
            >
              {t("management.soulDraft.apply")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void discard()}>
              {stale || conflict
                ? t("management.soulDraft.discardStale")
                : t("management.soulDraft.discard")}
            </Button>
          </div>
        </div>
      ) : null}
      {proposal?.status === "applied" ? <output>{t("management.soulDraft.applied")}</output> : null}
    </section>
  );
}
