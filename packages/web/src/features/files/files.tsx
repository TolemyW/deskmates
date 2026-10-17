// The Files screen (ADR-0014 amendment A2, issue #27 phase B): the workspace's referenced files
// as a list or a grid, filtered by type and source, searched and paged by the Gateway. The list
// is what chats and tasks referenced, not every file on the computer, and the screen says so.
// Opening an item shows its location, its references and the existing inert text preview and
// authenticated download (decisions 5 and 7). Members and above upload from here (amendment A5);
// nothing here renders file content as markup or an image, or starts the workspace.

import {
  FILE_COLLECTION_PAGE_SIZE,
  FILE_COLLECTION_SCAN_LIMIT,
  FILE_KINDS,
  type FileKind,
  type FileKindFilter,
  type FileReference,
  type FileSource,
  type FileSourceFilter,
  type Workspace,
  type WorkspaceFileCollectionPage,
  type WorkspaceFileItem,
} from "@deskmates/contracts";
import {
  Button,
  EmptyState,
  Input,
  Pager,
  Pill,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deskmates/ui";
import { File, FileImage, FileText, FolderOpen, Globe, LayoutGrid, List, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { contactHref, runHref, taskHref, threadHref } from "../../router.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { FilesAppsEntry } from "../app-shares/files-apps-entry.js";
import { FilesUploadControl } from "./files-upload.js";
import { UploadDeleteControl } from "./upload-delete.js";
import type { UploadApi } from "./upload-driver.js";
import { WorkspaceFilePreview, canPreviewWorkspacePath } from "./workspace-file-preview.js";

export type FilesApi = Pick<
  ApiClient,
  | "listWorkspaceFiles"
  | "downloadWorkspaceFile"
  | "workspaceFileDownloadUrl"
  | "readWorkspaceFileRange"
  | "deleteWorkspaceUploadFile"
> &
  UploadApi;

/** How long the search box waits after the last keystroke before asking the Gateway. */
export const FILES_SEARCH_DELAY_MS = 250;

const KIND_TEXT: Readonly<Record<FileKindFilter, MessageKey>> = {
  all: "files.type.all",
  documents: "files.type.documents",
  images: "files.type.images",
  web: "files.type.web",
  other: "files.type.other",
};

const SOURCE_TEXT: Readonly<Record<FileSource, MessageKey>> = {
  bot: "files.source.bot",
  uploaded: "files.source.uploaded",
  unknown: "files.source.unknown",
};

const REFERENCE_TEXT: Readonly<Record<FileReference["kind"], MessageKey>> = {
  publication: "files.ref.publication",
  task_artifact: "files.ref.taskArtifact",
  message_attachment: "files.ref.messageAttachment",
  message_path: "files.ref.messagePath",
  upload: "files.ref.upload",
};

function KindIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  if (kind === "documents") return <FileText size={size} aria-hidden="true" />;
  if (kind === "images") return <FileImage size={size} aria-hidden="true" />;
  if (kind === "web") return <Globe size={size} aria-hidden="true" />;
  return <File size={size} aria-hidden="true" />;
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

export function FilesScreen({ api }: { api: ApiClient }) {
  const scope = useWorkspaceScope(api);
  const t = useT();
  if (scope.error && !scope.loaded) return <p role="alert">{scope.error}</p>;
  if (!scope.loaded) return <p className="muted">{t("files.loadingWorkspace")}</p>;
  if (!scope.current)
    return (
      <section className="files-screen">
        <p className="muted">{t("files.noWorkspace")}</p>
      </section>
    );
  // A new workspace mounts a new view: no result, selection or pending answer carries over.
  return (
    <WorkspaceFiles
      key={scope.current.id}
      api={api}
      workspace={scope.current}
      apps={<FilesAppsEntry api={api} workspaceId={scope.current.id} />}
    />
  );
}

export function WorkspaceFiles({
  api,
  workspace,
  apps,
}: {
  api: FilesApi;
  workspace: Workspace;
  /** The published-apps entry (ADR-0035), owned by the app-shares feature. */
  apps?: ReactNode;
}) {
  const t = useT();
  const [type, setType] = useState<FileKindFilter>("all");
  const [source, setSource] = useState<FileSourceFilter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"list" | "grid">("list");
  const [page, setPage] = useState<WorkspaceFileCollectionPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WorkspaceFileItem>();
  const sequence = useRef(0);

  // Debounce typing; a changed search starts again from the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, FILES_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.listWorkspaceFiles(workspace.id, {
        offset,
        limit: FILE_COLLECTION_PAGE_SIZE,
        type,
        source,
        q,
      });
      if (request !== sequence.current) return;
      setPage(next);
    } catch (err) {
      if (request !== sequence.current) return;
      setPage(undefined);
      setError(errorMessage(err));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [api, workspace.id, offset, type, source, q]);

  useEffect(() => {
    void load();
  }, [load]);
  // A later answer must never land after the view is gone.
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const changeType = (next: FileKindFilter) => {
    setType(next);
    setOffset(0);
    setSelected(undefined);
  };
  const changeSource = (next: FileSourceFilter) => {
    setSource(next);
    setOffset(0);
    setSelected(undefined);
  };
  const clearFilters = () => {
    setType("all");
    setSource("all");
    setSearch("");
    setQ("");
    setOffset(0);
  };

  const items = page?.items ?? [];
  const filtered = type !== "all" || source !== "all" || q !== "";
  // A secondary path only where two items on this page share a name.
  const names = new Map<string, number>();
  for (const item of items) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  const ambiguous = (item: WorkspaceFileItem) => (names.get(item.name) ?? 0) > 1;

  return (
    <section className="files-screen">
      <header className="tasks-heading files-heading">
        <div>
          <span className="eyebrow">{workspace.name}</span>
          <h1>
            <FolderOpen size={24} aria-hidden="true" /> {t("files.title")}
          </h1>
          <p className="muted">{t("files.intro")}</p>
        </div>
        <FilesUploadControl api={api} workspace={workspace} onUploaded={() => void load()} />
      </header>
      {apps}
      <div className="files-toolbar">
        <div className="files-toolbar-row files-toolbar-primary">
          <fieldset className="app-tabs files-type-filter" aria-label={t("files.filter.type")}>
            {(["all", ...FILE_KINDS] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={type === kind ? "active" : ""}
                aria-label={t(KIND_TEXT[kind])}
                aria-pressed={type === kind}
                onClick={() => changeType(kind)}
              >
                {t(KIND_TEXT[kind])}
                {page ? (
                  <span className="files-facet-count" aria-hidden="true">
                    {kind === "all"
                      ? Object.values(page.facets.types).reduce((sum, count) => sum + count, 0)
                      : page.facets.types[kind]}
                  </span>
                ) : null}
              </button>
            ))}
          </fieldset>
          <fieldset className="app-tabs files-view-toggle" aria-label={t("files.view")}>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              aria-label={t("files.view.list")}
              title={t("files.view.list")}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={view === "grid" ? "active" : ""}
              aria-label={t("files.view.grid")}
              title={t("files.view.grid")}
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <LayoutGrid size={16} aria-hidden="true" />
            </button>
          </fieldset>
        </div>
        <div className="files-toolbar-row">
          <Input
            className="files-search"
            aria-label={t("files.search")}
            placeholder={t("files.searchPlaceholder")}
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          {page && (page.facets.sources.uploaded > 0 || source !== "all") ? (
            <Select
              label={t("files.filter.source")}
              value={source}
              onValueChange={(value) => changeSource(value as FileSourceFilter)}
              options={[
                { value: "all", label: t("files.source.all") },
                { value: "bot", label: t("files.source.bot") },
                ...(page.facets.sources.uploaded > 0
                  ? [{ value: "uploaded", label: t("files.source.uploaded") }]
                  : []),
              ]}
            />
          ) : null}
        </div>
        {filtered ? (
          <fieldset className="files-active-filters" aria-label={t("files.activeFilters")}>
            {type !== "all" ? (
              <button
                type="button"
                aria-label={`${t(KIND_TEXT[type])}: ${t("files.clearFilters")}`}
                onClick={() => changeType("all")}
              >
                {t(KIND_TEXT[type])} <X size={13} aria-hidden="true" />
              </button>
            ) : null}
            {source !== "all" ? (
              <button
                type="button"
                aria-label={`${t(SOURCE_TEXT[source])}: ${t("files.clearFilters")}`}
                onClick={() => changeSource("all")}
              >
                {t(SOURCE_TEXT[source])} <X size={13} aria-hidden="true" />
              </button>
            ) : null}
            {q !== "" ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setQ("");
                  setOffset(0);
                }}
              >
                {t("files.searchChip", { query: q })} <X size={13} aria-hidden="true" />
              </button>
            ) : null}
            <Button type="button" variant="ghost" onClick={clearFilters}>
              {t("files.clearFilters")}
            </Button>
          </fieldset>
        ) : null}
      </div>
      <p className="muted small files-scope">{t("files.scope")}</p>
      {page ? (
        <output className="muted small files-result-count">
          {t("files.resultCount", { count: page.total })}
        </output>
      ) : null}
      {page?.truncated ? (
        <output className="files-truncated">
          {t("files.truncated", { limit: FILE_COLLECTION_SCAN_LIMIT })}
        </output>
      ) : null}
      <div className={`files-layout${selected ? " with-detail" : ""}`}>
        <div className="files-results">
          {error ? (
            <div className="files-state" role="alert">
              <p>{t("files.error", { error })}</p>
              <Button type="button" onClick={() => void load()}>
                {t("files.retry")}
              </Button>
            </div>
          ) : loading && !page ? (
            <output className="muted files-state">{t("files.loading")}</output>
          ) : page && page.total === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} />}
              title={filtered ? t("files.emptyFiltered.title") : t("files.empty.title")}
            >
              <p>
                {source === "uploaded"
                  ? t("files.uploadedEmpty")
                  : filtered
                    ? t("files.emptyFiltered.bodyWithFilters", {
                        filters: [
                          type !== "all" ? t(KIND_TEXT[type]) : "",
                          source !== "all" ? t(SOURCE_TEXT[source]) : "",
                          q !== "" ? t("files.searchChip", { query: q }) : "",
                        ]
                          .filter(Boolean)
                          .join(", "),
                      })
                    : t("files.empty.body")}
              </p>
            </EmptyState>
          ) : view === "list" ? (
            <Table aria-label={t("files.listLabel")} className="files-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("files.column.name")}</TableHead>
                  <TableHead>{t("files.column.type")}</TableHead>
                  <TableHead>{t("files.column.source")}</TableHead>
                  <TableHead>{t("files.column.updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.path}
                    className={selected?.path === item.path ? "selected" : ""}
                  >
                    <TableCell>
                      <button
                        type="button"
                        className="files-name"
                        aria-label={t("files.open", { name: item.path })}
                        aria-expanded={selected?.path === item.path}
                        onClick={() => setSelected(item)}
                      >
                        <KindIcon kind={item.kind} />
                        <span>
                          <span className="files-name-text">{item.name}</span>
                          {ambiguous(item) ? (
                            <span className="muted small files-name-path">
                              {directoryOf(item.path)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell data-label={t("files.column.type")}>
                      {t(KIND_TEXT[item.kind])}
                    </TableCell>
                    <TableCell data-label={t("files.column.source")}>
                      <SourceLabel source={item.source} />
                    </TableCell>
                    <TableCell data-label={t("files.column.updated")}>
                      <When at={item.lastReferencedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <ul className="files-grid" aria-label={t("files.gridLabel")}>
              {items.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    className={selected?.path === item.path ? "selected" : ""}
                    aria-label={t("files.open", { name: item.path })}
                    aria-expanded={selected?.path === item.path}
                    onClick={() => setSelected(item)}
                  >
                    <span className={`files-thumb kind-${item.kind}`} aria-hidden="true">
                      <KindIcon kind={item.kind} size={28} />
                    </span>
                    <span className="files-name-text">{item.name}</span>
                    {ambiguous(item) ? (
                      <span className="muted small files-name-path">{directoryOf(item.path)}</span>
                    ) : null}
                    <span className="muted small">
                      {t("files.gridMeta", {
                        type: t(KIND_TEXT[item.kind]),
                        source: t(SOURCE_TEXT[item.source]),
                      })}
                    </span>
                    <span className="muted small">
                      <When at={item.lastReferencedAt} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {page && page.total > 0 ? (
            <Pager
              className="files-pager"
              rangeClassName="muted small"
              label={t("files.pagination")}
              previousLabel={t("files.previous")}
              nextLabel={t("files.next")}
              range={t("files.range", {
                from: page.offset + 1,
                to: page.offset + page.items.length,
                total: page.total,
              })}
              busy={loading}
              hasPrevious={page.offset > 0}
              hasNext={page.offset + page.items.length < page.total}
              onPrevious={() => setOffset(Math.max(0, page.offset - page.limit))}
              onNext={() => setOffset(page.offset + page.limit)}
            />
          ) : null}
        </div>
        {selected ? (
          <FileDetail
            key={selected.path}
            api={api}
            workspace={workspace}
            item={selected}
            onClose={() => setSelected(undefined)}
            onDeleted={() => {
              setSelected(undefined);
              void load();
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/** A compact last-reference time for rows and tiles; the full time is in its tooltip. */
function When({ at }: { at: string }) {
  return (
    <time className="files-when" dateTime={at} title={formatDateTime(at)}>
      {formatRelative(at)}
    </time>
  );
}

/** ADR-0014 A4 decision 26: verified, legacy unverified, or a person's input. */
function VerificationLabel({ item }: { item: WorkspaceFileItem }) {
  const t = useT();
  return (
    <Pill
      tone={
        item.verification === "verified"
          ? "success"
          : item.verification === "unverified"
            ? "warning"
            : "neutral"
      }
    >
      {t(`files.verification.${item.verification}` as MessageKey)}
    </Pill>
  );
}

function SourceLabel({ source }: { source: FileSource }) {
  const t = useT();
  return (
    <Pill
      tone={source === "bot" ? "info" : "neutral"}
      title={source === "unknown" ? t("files.source.unknownTitle") : undefined}
    >
      {t(SOURCE_TEXT[source])}
    </Pill>
  );
}

/** Words for a failed read that say what happened and what the operator can do. */
function describeReadError(err: unknown, t: ReturnType<typeof useT>): string {
  if (err instanceof ApiError && err.details.reason === "workspace_not_running")
    return t("files.read.notRunning");
  if (err instanceof ApiError && err.details.reason === "file_not_found")
    return t("files.read.missing");
  if (err instanceof ApiError && err.code === "payload_too_large") return t("files.read.tooLarge");
  return errorMessage(err);
}

function FileDetail({
  api,
  workspace,
  item,
  onClose,
  onDeleted,
}: {
  api: FilesApi;
  workspace: Workspace;
  item: WorkspaceFileItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [size, setSize] = useState<number>();
  const panelRef = useRef<HTMLElement>(null);
  // Move focus into the panel when it opens so keyboard and screen-reader users land on it.
  useEffect(() => panelRef.current?.focus(), []);
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className="files-detail"
      aria-label={t("files.detail.label", { name: item.name })}
    >
      <div className="files-detail-heading">
        <h2>
          <KindIcon kind={item.kind} size={18} /> <span>{item.name}</span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("files.detail.close")}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <dl className="files-facts">
        <dt>{t("files.detail.location")}</dt>
        <dd>
          <code>{item.path}</code>
        </dd>
        <dt>{t("files.detail.type")}</dt>
        <dd>{t(KIND_TEXT[item.kind])}</dd>
        <dt>{t("files.detail.size")}</dt>
        <dd>
          {size === undefined ? (
            <span className="muted">{t("files.detail.sizeUnknown")}</span>
          ) : (
            t("files.detail.sizeBytes", { bytes: size })
          )}
        </dd>
        <dt>{t("files.column.source")}</dt>
        <dd>
          <SourceLabel source={item.source} />
          {item.source === "unknown" ? (
            <span className="muted small"> {t("files.detail.unknownSource")}</span>
          ) : null}
        </dd>
        <dt>{t("files.detail.verification")}</dt>
        <dd>
          <VerificationLabel item={item} />
          {item.publication ? (
            <>
              <span className="files-note small">
                {t("files.detail.checked", {
                  size: item.publication.sizeBytes,
                  sha: item.publication.sha256.slice(0, 16),
                  time: formatDateTime(item.publication.checkedAt),
                  check: item.publication.check,
                })}
              </span>
              <span className="files-note small">
                {t(
                  item.publication.taskDeleted
                    ? "files.detail.publishedFromDeleted"
                    : "files.detail.publishedFrom",
                  {
                    kind: t(`files.detail.kind.${item.publication.deliveryKind}` as MessageKey),
                    title: item.publication.taskTitle,
                  },
                )}
              </span>
              {item.publication.supersededCount > 0 ? (
                <span className="muted small files-note">
                  {t("files.detail.replaced", { count: item.publication.supersededCount })}
                </span>
              ) : null}
              <span className="muted small files-note">{t("files.detail.checkedNote")}</span>
            </>
          ) : (
            <span className="muted small files-note">
              {t(
                item.verification === "input"
                  ? "files.detail.inputNote"
                  : "files.detail.unverifiedNote",
              )}
            </span>
          )}
        </dd>
        <dt>{t("files.column.updated")}</dt>
        <dd>
          {formatDateTime(item.lastReferencedAt)}
          <span className="muted small files-note">{t("files.detail.lastReferencedNote")}</span>
        </dd>
      </dl>
      <p className="muted small">{t("files.detail.currentBytes")}</p>
      {canPreviewWorkspacePath(item.path) ? null : (
        <p className="muted small files-note">{t("files.detail.previewUnsupported")}</p>
      )}
      <WorkspaceFilePreview
        api={api as ApiClient}
        workspaceId={workspace.id}
        path={item.path}
        describeError={(err) => describeReadError(err, t)}
        onRead={setSize}
      />
      <UploadDeleteControl api={api} workspaceId={workspace.id} item={item} onDeleted={onDeleted} />
      <section className="files-references" aria-label={t("files.detail.references")}>
        <h3>
          {t("files.detail.references")}{" "}
          <span className="muted small">{t("files.count", { count: item.referenceCount })}</span>
        </h3>
        {item.referenceCount > item.references.length ? (
          <p className="muted small">
            {t("files.detail.moreReferences", {
              shown: item.references.length,
              count: item.referenceCount,
            })}
          </p>
        ) : null}
        <ul>
          {item.references.map((ref, index) => (
            <ReferenceRow
              key={`${ref.kind}:${ref.messageId ?? ref.taskId ?? index}`}
              reference={ref}
            />
          ))}
        </ul>
      </section>
    </aside>
  );
}

function ReferenceRow({ reference: ref }: { reference: FileReference }) {
  const t = useT();
  const links: ReactNode[] = [];
  if (ref.taskId)
    links.push(
      <a key="task" href={taskHref(ref.taskId)}>
        {t("files.ref.task", { title: ref.taskTitle ?? ref.taskId })}
      </a>,
    );
  if (ref.threadId)
    links.push(
      <a key="thread" href={threadHref(ref.threadId, ref.messageId)}>
        {t("files.ref.thread", { title: ref.threadTitle || ref.threadId })}
      </a>,
    );
  if (ref.runId)
    links.push(
      <a key="run" href={runHref(ref.runId)}>
        {t("files.ref.run")}
      </a>,
    );
  const who =
    ref.botId && ref.botName ? (
      <a href={contactHref(ref.botId)}>{t("files.ref.bot", { name: ref.botName })}</a>
    ) : ref.authorKind === "human" ? (
      <span>{t("files.ref.person")}</span>
    ) : ref.kind === "upload" ? (
      <span>
        {t("files.ref.uploadedBy", {
          uploader: ref.uploader ?? "",
          size: ref.sizeBytes ?? 0,
          sha: (ref.sha256 ?? "").slice(0, 12),
        })}
      </span>
    ) : ref.kind === "task_artifact" ? (
      <span className="muted">{t("files.ref.noRun")}</span>
    ) : (
      <span className="muted">{t("files.ref.unknownBot")}</span>
    );
  return (
    <li className="files-reference">
      <div className="files-reference-head">
        <strong>{t(REFERENCE_TEXT[ref.kind])}</strong>
        {ref.usedInDelivery ? <Pill tone="success">{t("files.ref.usedInDelivery")}</Pill> : null}
      </div>
      {ref.label ? <span className="files-reference-label">{ref.label}</span> : null}
      <div className="files-reference-meta small">
        {who}
        {links}
        <span className="muted">{formatDateTime(ref.at)}</span>
      </div>
    </li>
  );
}
