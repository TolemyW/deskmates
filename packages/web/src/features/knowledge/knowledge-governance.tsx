import type { KnowledgeHit, KnowledgeProposal, KnowledgeVersion } from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { KNOWLEDGE_PAGE_SIZE, pageOf } from "./knowledge-paging.js";

export type KnowledgeGovernanceApi = ApiClient;

/** A proposal's status as the history list shows it. */
const PROPOSAL_STATE: Readonly<Record<KnowledgeProposal["status"], MessageKey>> = {
  pending: "knowledgeGovernance.proposals.state.pending",
  approved: "knowledgeGovernance.proposals.state.approved",
  rejected: "knowledgeGovernance.proposals.state.rejected",
};

export function KnowledgeGovernance({ api }: { api: KnowledgeGovernanceApi }) {
  const [proposalStatus, setProposalStatus] = useState<KnowledgeProposal["status"]>("pending");
  // Published documents and proposals page explicitly (#113); history keeps "Load older".
  const documentPages = usePagedQuery<KnowledgeHit>({
    scopeKey: "governance.documents",
    limit: KNOWLEDGE_PAGE_SIZE,
    mode: "cursor",
    historyKey: "knowledge.governance.documents",
    fetchPage: async ({ cursor, limit }) =>
      pageOf(
        await api.listKnowledgePage({ ...(cursor ? { cursor } : {}), limit }),
        (page) => page.documents,
      ),
  });
  const proposalPages = usePagedQuery<KnowledgeProposal>({
    scopeKey: `governance.proposals:${proposalStatus}`,
    limit: KNOWLEDGE_PAGE_SIZE,
    mode: "cursor",
    historyKey: "knowledge.governance.proposals",
    fetchPage: async ({ cursor, limit }) =>
      pageOf(
        await api.listKnowledgeProposalsPage({
          status: proposalStatus,
          ...(cursor ? { cursor } : {}),
          limit,
        }),
        (page) => page.proposals,
      ),
  });
  const documents = documentPages.items;
  const proposals = proposalPages.items;
  const listError = documentPages.error ?? proposalPages.error;
  const [history, setHistory] = useState<KnowledgeVersion[]>([]);
  const [historyId, setHistoryId] = useState("");
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canCleanUp = useCan("knowledge.cleanup").allowed;
  const t = useT();

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const loadHistory = async (id: string, cursor?: string) => {
    const page = await api.listKnowledgeHistory(id, {
      ...(cursor ? { cursor } : {}),
      limit: 25,
    });
    setHistoryId(id);
    setHistory((current) => (cursor ? [...current, ...page.versions] : page.versions));
    setHistoryCursor(page.nextCursor);
  };

  return (
    <section className="knowledge-governance">
      <h2>{t("knowledgeGovernance.maintenance")}</h2>
      <p className="muted small">{t("knowledgeGovernance.introShort")}</p>

      {error && <p role="alert">{error}</p>}
      {!error && listError ? <p role="alert">{errorMessage(listError)}</p> : null}
      {notice && <output>{notice}</output>}

      <section>
        <h3>{t("knowledgeGovernance.published.title")}</h3>
        <ul className="gov-list">
          {documents.map((document) => (
            <li key={document.id}>
              <Button
                type="button"
                variant="ghost"
                className="history-document"
                disabled={busy}
                onClick={() => void perform(() => loadHistory(document.id))}
              >
                {t("knowledgeGovernance.published.history", {
                  title: document.title,
                  version: document.version,
                })}
              </Button>
            </li>
          ))}
        </ul>
        <PageBar query={documentPages} label={t("knowledgeGovernance.published.pages")} />
        <Button
          type="button"
          variant="tertiary"
          disabled={busy || !canCleanUp}
          onClick={() =>
            void perform(async () => {
              const result = await api.cleanupKnowledgeVersions();
              setNotice(
                t("knowledgeGovernance.cleanup.done", {
                  removed: result.removed,
                  retained: result.retained,
                }),
              );
            })
          }
        >
          {t("knowledgeGovernance.cleanup.button")}
        </Button>
        <RoleNote action="knowledge.cleanup" does={t("knowledgeGovernance.cleanup.does")} />
        {historyId && (
          <div aria-label={t("knowledgeGovernance.history.label")} className="gov-history">
            <h4>{t("knowledgeGovernance.history.title")}</h4>
            {history.map((version) => (
              <details key={version.version}>
                <summary>
                  {t("knowledgeGovernance.history.summary", {
                    version: version.version,
                    approvedBy: version.approvedBy,
                    createdAt: version.createdAt,
                  })}
                </summary>
                {version.sourceRunId && (
                  <a href={`#/runs/${encodeURIComponent(version.sourceRunId)}`}>
                    {t("knowledgeGovernance.sourceRun")}
                  </a>
                )}
                <strong>{version.title}</strong>
                <pre>{version.body}</pre>
              </details>
            ))}
            {historyCursor && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void perform(() => loadHistory(historyId, historyCursor))}
              >
                {t("knowledgeGovernance.history.loadOlder")}
              </Button>
            )}
          </div>
        )}
      </section>

      <section>
        <h3>{t("knowledgeGovernance.proposals.title")}</h3>
        <Select
          label={t("knowledgeGovernance.proposals.status")}
          value={proposalStatus}
          disabled={busy}
          onValueChange={(value) => setProposalStatus(value as KnowledgeProposal["status"])}
          options={[
            {
              value: "pending",
              label: t("knowledgeGovernance.proposals.option.pending"),
            },
            {
              value: "approved",
              label: t("knowledgeGovernance.proposals.option.approved"),
            },
            {
              value: "rejected",
              label: t("knowledgeGovernance.proposals.option.rejected"),
            },
          ]}
        />

        {proposals.map((proposal) => (
          <details key={proposal.id}>
            <summary>
              {t("knowledgeGovernance.proposals.summary", {
                title: proposal.title,
                status: t(PROPOSAL_STATE[proposal.status]),
              })}
            </summary>
            {proposal.sourceRunId && (
              <a href={`#/runs/${encodeURIComponent(proposal.sourceRunId)}`}>
                {t("knowledgeGovernance.sourceRun")}
              </a>
            )}
            <pre>{proposal.body}</pre>
          </details>
        ))}
        <PageBar query={proposalPages} label={t("knowledgeGovernance.proposals.pages")} />
      </section>

      <p className="muted small">
        {t.rich("knowledgeGovernance.facts.short", {
          link: (text) => <a href="#/knowledge/observations">{text}</a>,
        })}
      </p>
    </section>
  );
}
