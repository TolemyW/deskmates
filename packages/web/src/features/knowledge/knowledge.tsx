import type {
  BotDefinition,
  BotId,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeProposal,
} from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { FileText, Plus, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ApiClient, MemoryView } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { Input, TextArea } from "../../components/ui/input.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";

import { RoleNote, useCan } from "../../state/session-roles.js";
import { KnowledgeGovernance, type KnowledgeGovernanceApi } from "./knowledge-governance.js";
import { KNOWLEDGE_PAGE_SIZE, pageOf } from "./knowledge-paging.js";
import { type KnowledgeDraft, type MemoryDraft, operatorDrafts } from "./operator-drafts.js";

const NEW_PROPOSAL = "new-proposal";

function exportMarkdown(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DirtyGuard({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="draft-guard" role="alertdialog" aria-label={t("knowledge.dirty.label")}>
      <p>{t("knowledge.dirty.body")}</p>
      <Button type="button" onClick={onKeep}>
        {t("knowledge.dirty.keep")}
      </Button>
      <Button type="button" onClick={onDiscard}>
        {t("knowledge.dirty.discard")}
      </Button>
    </div>
  );
}

export function KnowledgeScreen({ api }: { api: ApiClient }) {
  const governanceApi = "listKnowledgePage" in api ? (api as KnowledgeGovernanceApi) : undefined;
  return (
    <div className="knowledge-screen">
      <KnowledgePanel api={api} />
      <MemoryPanel api={api} />
      {governanceApi && <KnowledgeGovernance api={governanceApi} />}
    </div>
  );
}

export function KnowledgePanel({ api }: { api: ApiClient }) {
  const editorId = useId();
  const t = useT();

  const mounted = useRef(true);
  const retained = operatorDrafts(api);
  const initialKey = retained.knowledgeSelection ?? NEW_PROPOSAL;
  const initial = retained.knowledge.get(initialKey);
  // The search the list shows: set when the form is submitted, not while typing.
  const [searched, setSearched] = useState("");
  const documentPages = usePagedQuery<KnowledgeHit>({
    scopeKey: `documents:${searched}`,
    limit: KNOWLEDGE_PAGE_SIZE,
    // A search pages by offset over the rank; the library by cursor, newest first.
    mode: searched ? "offset" : "cursor",
    historyKey: "knowledge.documents",
    fetchPage: async ({ offset, cursor, limit }) =>
      pageOf(
        await api.listKnowledgePage(
          searched ? { q: searched, offset, limit } : { ...(cursor ? { cursor } : {}), limit },
        ),
        (page) => page.documents,
      ),
  });
  const proposalPages = usePagedQuery<KnowledgeProposal>({
    scopeKey: "proposals:pending",
    limit: KNOWLEDGE_PAGE_SIZE,
    mode: "cursor",
    historyKey: "knowledge.proposals",
    fetchPage: async ({ cursor, limit }) =>
      pageOf(
        await api.listKnowledgeProposalsPage({
          status: "pending",
          ...(cursor ? { cursor } : {}),
          limit,
        }),
        (page) => page.proposals,
      ),
  });
  const documents = documentPages.items;
  const proposals = proposalPages.items;
  const listError = documentPages.error ?? proposalPages.error;
  const [selection, setSelection] = useState(initialKey);
  const [draft, setDraft] = useState<KnowledgeDraft>(
    initial ?? { title: "", body: "", dirty: false },
  );
  const [editorOpen, setEditorOpen] = useState(Boolean(initial?.dirty || initial?.loaded));
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>();
  const canReview = useCan("knowledge.review").allowed;
  const canEdit = useCan("knowledge.edit").allowed;

  const keepDraft = (next: KnowledgeDraft) => {
    if (!mounted.current) return;
    retained.knowledgeSelection = selection;
    retained.knowledge.set(selection, next);
    setDraft(next);
  };
  const show = (key: string, next: KnowledgeDraft) => {
    if (!mounted.current) return;
    retained.knowledgeSelection = key;
    retained.knowledge.set(key, next);
    setSelection(key);
    setEditorOpen(true);
    setDraft(next);
    setError("");
    setNotice("");
  };
  const runOrGuard = (action: () => void) => {
    if (draft.dirty) {
      setPendingAction(() => action);
      return;
    }
    action();
  };
  const discardAndContinue = () => {
    retained.knowledge.delete(selection);
    const action = pendingAction;
    setPendingAction(undefined);
    action?.();
  };
  const act = async (operation: () => Promise<void>) => {
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
  /** Refetch the pages shown; a new search starts its results from the first page. */
  const refresh = async () => {
    const next = query.trim();
    if (next !== searched) setSearched(next);
    else documentPages.reload();
    proposalPages.reload();
  };
  const loadDocument = async (id: string) => {
    const saved = retained.knowledge.get(id);
    if (saved) {
      show(id, saved);
      return;
    }
    const doc = await api.getKnowledge(id);
    show(id, { title: doc.title, body: doc.body, dirty: false, loaded: doc });
  };
  const reloadDocument = async () => {
    if (!draft.loaded) return;
    const doc = await api.getKnowledge(draft.loaded.id);
    show(doc.id, { title: doc.title, body: doc.body, dirty: false, loaded: doc });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <section className="knowledge-panel">
      <div className="knowledge-head">
        <div className="knowledge-heading">
          <h2>
            {t("knowledge.documents.title")}{" "}
            <span className="knowledge-count">{documentPages.page?.total ?? documents.length}</span>
          </h2>
          <p>{t("knowledge.documents.introShort")}</p>
        </div>
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() =>
            selection === NEW_PROPOSAL
              ? setEditorOpen(true)
              : runOrGuard(() =>
                  show(
                    NEW_PROPOSAL,
                    retained.knowledge.get(NEW_PROPOSAL) ?? { title: "", body: "", dirty: false },
                  ),
                )
          }
        >
          <Plus size={16} /> {t("knowledge.editor.newDocument")}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!error && listError ? <p role="alert">{errorMessage(listError)}</p> : null}
      {notice && <output>{notice}</output>}
      {pendingAction && (
        <DirtyGuard onKeep={() => setPendingAction(undefined)} onDiscard={discardAndContinue} />
      )}
      <form
        className="knowledge-search"
        onSubmit={(event) => {
          event.preventDefault();
          void act(refresh);
        }}
      >
        <label className="memory-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("knowledge.search.label")}
            placeholder={t("knowledge.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button type="submit" variant="tertiary" disabled={busy}>
          {t("knowledge.search.button")}
        </Button>
      </form>
      <ul className="doc-list">
        {documents.length === 0 ? (
          <li className="doc-row empty muted small">{t("knowledge.documents.emptyShort")}</li>
        ) : null}
        {documents.map((item) => (
          <li key={item.id} className={`doc-row${draft.loaded?.id === item.id ? " selected" : ""}`}>
            <button
              type="button"
              className="doc-row-button"
              disabled={busy}
              onClick={() =>
                runOrGuard(() => {
                  void act(() => loadDocument(item.id));
                })
              }
            >
              <FileText size={16} aria-hidden="true" />
              <span className="doc-title">
                {t("knowledge.documents.row", { title: item.title, version: item.version })}
              </span>
            </button>
            <p className="muted small doc-excerpt">{item.excerpt}</p>
          </li>
        ))}
      </ul>
      <PageBar query={documentPages} label={t("knowledge.documents.pages")} />

      {editorOpen ? (
        <section className="knowledge-edit-region" aria-label={t("knowledge.editor.label")}>
          <div className="knowledge-editor-heading">
            <h2>
              {draft.loaded
                ? t("knowledge.editor.editTitle", { version: draft.loaded.version })
                : t("knowledge.editor.newDocument")}
            </h2>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("knowledge.editor.close")}
              onClick={() => setEditorOpen(false)}
            >
              <X size={18} />
            </Button>
          </div>
          {draft.loaded ? null : <p className="muted small">{t("knowledge.editor.reviewFirst")}</p>}
          <form
            className="knowledge-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                if (draft.loaded) {
                  try {
                    const saved = await api.editKnowledge(
                      draft.loaded.id,
                      draft.title,
                      draft.body,
                      draft.loaded.version,
                    );
                    show(saved.id, {
                      title: saved.title,
                      body: saved.body,
                      dirty: false,
                      loaded: saved,
                    });
                    setNotice("Document saved.");
                  } catch (err) {
                    if (err instanceof ApiError && err.status === 409) {
                      const latest = await api.getKnowledge(draft.loaded.id);
                      keepDraft({ ...draft, latest });
                    }
                    throw err;
                  }
                } else {
                  await api.proposeKnowledge(draft.title, draft.body);
                  if (!mounted.current) return;
                  retained.knowledge.delete(NEW_PROPOSAL);
                  show(NEW_PROPOSAL, { title: "", body: "", dirty: false });
                  setNotice("Proposal awaiting review.");
                  setEditorOpen(false);
                }
                await refresh();
              });
            }}
          >
            <fieldset disabled={busy}>
              <label htmlFor={`${editorId}-title`}>
                {t("knowledge.editor.title")}
                <Input
                  id={`${editorId}-title`}
                  required
                  maxLength={200}
                  value={draft.title}
                  onChange={(event) =>
                    keepDraft({ ...draft, title: event.target.value, dirty: true })
                  }
                />
              </label>
              <label htmlFor={`${editorId}-body`}>
                {t("knowledge.editor.markdown")}
                <TextArea
                  id={`${editorId}-body`}
                  required
                  rows={8}
                  value={draft.body}
                  onChange={(event) =>
                    keepDraft({ ...draft, body: event.target.value, dirty: true })
                  }
                />
              </label>
              <div className="knowledge-editor-actions">
                <Button
                  type="submit"
                  variant="default"
                  disabled={draft.loaded !== undefined && !canEdit}
                >
                  {draft.loaded ? t("knowledge.editor.save") : t("knowledge.editor.submit")}
                </Button>
                {draft.loaded && (
                  <>
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() =>
                        runOrGuard(() => {
                          void act(reloadDocument);
                        })
                      }
                    >
                      {t("knowledge.editor.reload")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() =>
                        exportMarkdown(`${draft.loaded?.id ?? "knowledge"}.md`, draft.body)
                      }
                    >
                      {t("knowledge.editor.export")}
                    </Button>
                  </>
                )}
              </div>
            </fieldset>
          </form>
          {draft.latest && (
            <aside className="draft-latest" aria-label={t("knowledge.latest.label")}>
              <h3>{t("knowledge.latest.title", { version: draft.latest.version })}</h3>
              <strong>{draft.latest.title}</strong>
              <pre>{draft.latest.body}</pre>
              <p>{t("knowledge.latest.localDraft")}</p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  const latest = draft.latest;
                  if (!latest) return;
                  const { latest: _previousLatest, ...local } = draft;
                  keepDraft({ ...local, loaded: latest, dirty: true });
                }}
              >
                {t("knowledge.latest.useAsBase")}
              </Button>
            </aside>
          )}
        </section>
      ) : null}
      <h2 className="knowledge-subhead">
        {t("knowledge.pending.title", {
          count: proposalPages.page?.total ?? proposals.length,
        })}
      </h2>
      <RoleNote action="knowledge.review" does={t("knowledge.pending.does")} />
      {proposals.length === 0 ? (
        <p className="muted small">{t("knowledge.pending.emptyShort")}</p>
      ) : null}
      {proposals.map((proposal) => (
        <details key={proposal.id} className="proposal">
          <summary>
            <span className="pill warning">{t("knowledge.pending.pill")}</span> {proposal.title}
          </summary>
          <div className="proposal-body">
            {proposal.sourceRunId && (
              <a className="small" href={`#/runs/${encodeURIComponent(proposal.sourceRunId)}`}>
                {t("knowledge.pending.sourceRun")}
              </a>
            )}
            {proposal.citations?.length ? (
              <p className="muted small">
                {t("knowledge.pending.citations", {
                  count: proposal.citations.length,
                  changed: proposal.citations.filter((c) => c.changed).length,
                })}
              </p>
            ) : null}
            {proposal.targetDocumentId ? (
              <p className="muted small">
                {t("knowledge.pending.updates", { version: proposal.targetVersion ?? 1 })}
              </p>
            ) : null}
            <pre>{proposal.body}</pre>
            <div className="knowledge-editor-actions">
              {(["approve", "reject"] as const).map((decision) => (
                <Button
                  key={decision}
                  type="button"
                  variant={decision === "approve" ? "default" : "tertiary"}
                  disabled={busy || !canReview}
                  onClick={() =>
                    void act(async () => {
                      await api.reviewKnowledge(proposal.id, decision);
                      await refresh();
                      setNotice(
                        decision === "approve"
                          ? t("knowledge.notice.published")
                          : t("knowledge.notice.rejected"),
                      );
                    })
                  }
                >
                  {decision === "approve"
                    ? t("knowledge.pending.approve")
                    : t("knowledge.pending.reject")}
                </Button>
              ))}
            </div>
          </div>
        </details>
      ))}
      <PageBar query={proposalPages} label={t("knowledge.pending.pages")} />
    </section>
  );
}

export function MemoryPanel({
  api,
  botId: fixedBotId,
  versions,
}: {
  api: ApiClient;
  botId?: BotId;
  /**
   * Rendered under the editor with the loaded version, whether the draft is unsaved, and a reload
   * for after a restore; the bot profile shows MEMORY.md's saved versions here (ADR-0043).
   */
  versions?: (current: { version: string; dirty: boolean; reload: () => void }) => ReactNode;
}) {
  const t = useT();
  // MEMORY.md is configuration: an Admin edits it, a Member reads (ADR-0022 amendment 1, C2).
  const canEditMemory = useCan("memory.editFile").allowed;
  const mounted = useRef(true);
  const retained = operatorDrafts(api);
  const initialId = fixedBotId ?? retained.memorySelection ?? "";
  const initial = initialId ? retained.memory.get(initialId) : undefined;
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [botId, setBotId] = useState<BotId | "">(initialId as BotId | "");
  const [draft, setDraft] = useState<MemoryDraft | undefined>(initial);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>();

  const show = (id: BotId, next: MemoryDraft) => {
    if (!mounted.current) return;
    retained.memorySelection = id;
    retained.memory.set(id, next);
    setBotId(id);
    setDraft(next);
    setError("");
    setNotice("");
  };
  const loadMemory = async (id: BotId, fresh = false) => {
    const saved = retained.memory.get(id);
    if (!fresh && saved) {
      show(id, saved);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const loaded = await api.readMemory(id);
      show(id, { body: loaded.body, loaded, dirty: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const runOrGuard = (action: () => void) => {
    if (draft?.dirty) setPendingAction(() => action);
    else action();
  };
  const discardAndContinue = () => {
    if (botId) retained.memory.delete(botId);
    const action = pendingAction;
    setPendingAction(undefined);
    action?.();
  };

  useEffect(() => {
    mounted.current = true;
    let active = true;
    api
      .listBots()
      .then((items) => {
        if (active) setBots(items);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [api]);
  // A profile fixes the bot: load its notes once the roster names it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMemory is stable per api/bot.
  useEffect(() => {
    if (fixedBotId && bots.some((bot) => bot.id === fixedBotId) && !draft) {
      void loadMemory(fixedBotId);
    }
  }, [fixedBotId, bots]);

  return (
    <section className="knowledge-panel">
      <h1>
        {fixedBotId ? t("knowledge.memory.yourNotesTitle") : t("knowledge.memory.botMemoryTitle")}
      </h1>
      <p>
        {fixedBotId ? t("knowledge.memory.yourNotesIntro") : t("knowledge.memory.botMemoryIntro")}
      </p>
      {fixedBotId ? null : (
        <Select
          label={t("knowledge.memory.bot")}
          value={botId}
          disabled={busy}
          onValueChange={(value) => {
            const nextId = value as BotId | "";
            if (!nextId) return;
            runOrGuard(() => void loadMemory(nextId));
          }}
          options={[
            {
              value: "",
              label: t("knowledge.memory.selectBot"),
            },
            ...bots.map((bot) => ({
              value: bot.id,
              label: bot.name,
            })),
          ]}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      {pendingAction && (
        <DirtyGuard onKeep={() => setPendingAction(undefined)} onDiscard={discardAndContinue} />
      )}
      <Button
        type="button"
        disabled={busy || !botId}
        onClick={() => {
          if (!botId) return;
          const selectedBot = botId;
          runOrGuard(() => {
            void loadMemory(selectedBot, true);
          });
        }}
      >
        {t("knowledge.memory.reload")}
      </Button>
      {draft && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const bot = bots.find((item) => item.id === botId);
            if (!bot) return;
            setBusy(true);
            setError("");
            setNotice("");
            try {
              const { appliesFromNextRun, ...saved } = await api.writeMemory(
                bot.id,
                draft.body,
                draft.loaded.version,
              );
              show(bot.id, { body: saved.body, loaded: saved, dirty: false });
              // ADR-0043 decision 3: a live or parked run keeps what it started with.
              setNotice(
                appliesFromNextRun
                  ? t("knowledge.notice.memorySavedNextRun")
                  : t("knowledge.notice.memorySaved"),
              );
            } catch (err) {
              if (err instanceof ApiError && err.status === 409) {
                try {
                  const latest = await api.readMemory(bot.id);
                  if (!mounted.current) return;
                  const next = { ...draft, latest };
                  retained.memory.set(bot.id, next);
                  setDraft(next);
                } catch {
                  // Keep the original conflict visible when the latest version cannot be loaded.
                }
              }
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy}>
            <label>
              {t("knowledge.memory.markdown")}
              <textarea
                rows={16}
                readOnly={!canEditMemory}
                value={draft.body}
                onChange={(event) => {
                  const next = { ...draft, body: event.target.value, dirty: true };
                  retained.memory.set(botId, next);
                  setDraft(next);
                }}
              />
            </label>
            {canEditMemory ? <Button type="submit">{t("knowledge.memory.save")}</Button> : null}
            <Button type="button" onClick={() => exportMarkdown("MEMORY.md", draft.body)}>
              {t("knowledge.memory.export")}
            </Button>
            <RoleNote action="memory.editFile" does={t("knowledge.memory.roleNote")} />
          </fieldset>
        </form>
      )}
      {draft && botId && versions
        ? versions({
            version: draft.loaded.version,
            dirty: draft.dirty,
            reload: () => void loadMemory(botId, true),
          })
        : null}
      {draft?.latest && (
        <aside className="draft-latest" aria-label={t("knowledge.memoryLatest.label")}>
          <h3>{t("knowledge.memoryLatest.title")}</h3>
          <pre>{draft.latest.body}</pre>
          <p>{t("knowledge.latest.localDraft")}</p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!draft.latest) return;
              const { latest, ...local } = draft;
              const next = {
                ...local,
                loaded: latest,
                dirty: true,
              };
              retained.memory.set(botId, next);
              setDraft(next);
            }}
          >
            {t("knowledge.latest.useAsBase")}
          </Button>
        </aside>
      )}
    </section>
  );
}
