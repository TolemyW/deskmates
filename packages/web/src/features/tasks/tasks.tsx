import {
  type BotDefinition,
  type BotId,
  type CreateTaskInput,
  type RunId,
  TASK_STATUSES,
  type Task,
  type TaskArtifact,
  type TaskStatus,
  type ThreadId,
  type UpdateTaskInput,
  type Workspace,
  workspaceFileRoot,
} from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { ButtonLink, Input, MetricCard, TextArea } from "@deskmates/ui";
import { ClipboardList, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { PageBar } from "../../lib/page-bar.js";
import { type PageResult, usePagedQuery } from "../../lib/use-paged-query.js";
import { contactHref, navigate, runHref, taskHref, threadHref } from "../../router.js";
import { useActorLabel } from "../../state/session-roles.js";
import { NextAction, RoleNote, useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";
import {
  TaskExecutionPanel,
  TaskTriggerFields,
  newIdempotencyKey,
  triggerDraft,
  triggerRequest,
} from "./task-execution.js";

/** Tasks: 25 a page from the Gateway, which filters and searches before paging (#113). */
export const TASK_PAGE_SIZE = 25;
/** How long typing settles before the search goes to the Gateway. */
const TASK_SEARCH_DELAY_MS = 250;

/** A tasks page carries the whole workspace's counts by status, for the metric cards. */
type TaskPageResult = PageResult<Task> & { statusCounts: Record<TaskStatus, number> };

const STATUS_LABELS: Record<TaskStatus, MessageKey> = {
  planned: "tasks.status.planned",
  in_progress: "tasks.status.inProgress",
  blocked: "tasks.status.blocked",
  delivered: "tasks.status.delivered",
  accepted: "tasks.status.accepted",
  cancelled: "tasks.status.cancelled",
};

interface ArtifactDraft {
  key: number;
  label: string;
  path: string;
  runId: string;
}

interface TaskDraft {
  title: string;
  description: string;
  ownerBotId: string;
  status: TaskStatus;
  blockedReason: string;
  nextAction: string;
  threadIds: string;
  runIds: string;
  artifacts: ArtifactDraft[];
}

function draftOf(task?: Task): TaskDraft {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    ownerBotId: task?.ownerBotId ?? "",
    status: task?.status ?? "planned",
    blockedReason: task?.blockedReason ?? "",
    nextAction: task?.nextAction ?? "",
    threadIds: task?.threadIds.join("\n") ?? "",
    runIds: task?.runIds.join("\n") ?? "",
    artifacts:
      task?.artifacts.map((artifact, key) => ({ ...artifact, key, runId: artifact.runId ?? "" })) ??
      [],
  };
}

/** Accept copied app links as well as IDs, without ever visiting pasted URLs. */
export function taskReferenceIds(text: string, kind: "threads" | "runs"): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((value) => {
          const match = new RegExp(`^(?:https?://[^#]+)?#/${kind}/([^/]+)$`).exec(value);
          if (!match?.[1]) return value;
          try {
            return decodeURIComponent(match[1]);
          } catch {
            return value;
          }
        }),
    ),
  ];
}

function taskInput(draft: TaskDraft): CreateTaskInput {
  return {
    title: draft.title.trim(),
    description: draft.description,
    ownerBotId: (draft.ownerBotId as BotId) || null,
    threadIds: taskReferenceIds(draft.threadIds, "threads") as ThreadId[],
    runIds: taskReferenceIds(draft.runIds, "runs") as RunId[],
    artifacts: draft.artifacts.map(
      (artifact): TaskArtifact => ({
        label: artifact.label.trim(),
        path: artifact.path.trim(),
        ...(artifact.runId.trim() ? { runId: artifact.runId.trim() as RunId } : {}),
      }),
    ),
  };
}

function TaskStatusLabel({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  const t = useT();
  const label =
    compact && status === "delivered"
      ? t("tasks.status.awaitingReview")
      : compact && status === "accepted"
        ? t("tasks.status.acceptedShort")
        : t(STATUS_LABELS[status]);
  return (
    <span className={`task-status ${status}`} title={t(STATUS_LABELS[status])}>
      {label}
    </span>
  );
}

/**
 * Who accepted: a signed-in person's `user:<id>` (ADR-0022 P1), or the historical label the
 * shared operator credential records, which names no individual.
 */
export function acceptedByLabel(
  acceptedBy: string | null,
  label: (actor: string) => string = (actor) => actor,
): string {
  if (acceptedBy === null) return "";
  const { t } = currentI18n();
  if (acceptedBy === "human:web") return t("tasks.by.sharedOperator", { label: acceptedBy });
  return acceptedBy.startsWith("user:")
    ? t("tasks.by.signedInPerson", { label: label(acceptedBy) })
    : acceptedBy;
}

/**
 * Who declared delivery: a bot through `task_deliver` (ADR-0021 amendment 2), or an operator with
 * the same labels acceptance uses. Delivery by anyone still waits for a human to accept.
 */
export function deliveredByLabel(
  deliveredBy: string | null,
  label: (actor: string) => string = (actor) => actor,
): string {
  if (deliveredBy?.startsWith("bot:"))
    return currentI18n().t("tasks.by.bot", { label: deliveredBy });
  return acceptedByLabel(deliveredBy, label);
}

/** Stored JSON shown as text: React escapes it, so bot output never becomes markup. */
function JsonBlock({ label, note, value }: { label: string; note: string; value: unknown }) {
  return (
    <section aria-label={label} className="task-json">
      <h3>{label}</h3>
      <p className="muted small">{note}</p>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

export function TasksScreen({ api, taskId }: { api: ApiClient; taskId?: string | undefined }) {
  const scope = useWorkspaceScope(api);
  const t = useT();
  if (scope.error && !scope.loaded) return <p role="alert">{scope.error}</p>;
  if (!scope.loaded) return <p className="muted">{t("tasks.loadingWorkspace")}</p>;
  if (!scope.current) {
    return (
      <section className="tasks-screen page-container">
        <p className="muted">{t("tasks.noWorkspace")}</p>
        <NextAction
          action="workspace.create"
          does={t("tasks.noWorkspace.does")}
          how={t("tasks.noWorkspace.how")}
        />
      </section>
    );
  }
  // A route/workspace change destroys the old editor before painting the next one. Its async
  // callbacks also check their lifetime, so late saves cannot navigate away from a newer task.
  return (
    <WorkspaceTasks
      key={`${scope.current.id}:${taskId ?? "new"}`}
      api={api}
      workspace={scope.current}
      taskId={taskId}
    />
  );
}

function WorkspaceTasks({
  api,
  workspace,
  taskId,
}: {
  api: ApiClient;
  workspace: Workspace;
  taskId: string | undefined;
}) {
  const fieldId = useId();
  const workspaceId = workspace.id;
  const actorName = useActorLabel();
  const t = useT();
  // Tasks are the group's: Admins create, edit and accept them; Members read (ADR-0022 amd. 1).
  const canEditTasks = useCan("task.edit").allowed;
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [task, setTask] = useState<Task>();
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf());
  // ADR-0021 A3a/A3b: how a new task takes effect, and one create key per intended create.
  const [trigger, setTrigger] = useState(triggerDraft);
  const createKey = useRef(newIdempotencyKey());
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const listSequence = useRef(0);
  const refreshingList = useRef(false);
  // Typing settles before the search goes to the Gateway; a new search starts at page one.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), TASK_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  // One page of tasks, filtered and searched by the Gateway, with the whole workspace's counts by
  // status (#113). The hook discards an answer for an older filter however late it lands.
  const pages = usePagedQuery<Task>({
    scopeKey: `tasks:${workspaceId}:${filter}:${search}`,
    limit: TASK_PAGE_SIZE,
    mode: "offset",
    historyKey: "tasks.list",
    fetchPage: async ({ offset, limit }): Promise<TaskPageResult> => {
      const page = await api.listTasks(workspaceId, {
        ...(filter === "all" ? {} : { status: filter as TaskStatus }),
        ...(search ? { q: search } : {}),
        offset,
        limit,
      });
      return {
        items: page.tasks.filter((item) => item.workspaceId === workspaceId),
        total: page.total,
        statusCounts: page.statusCounts,
      };
    },
  });
  const reloadPage = pages.reload;
  const tasksPage = pages.page as TaskPageResult | undefined;
  // A task saved or deleted here shows at once, before the reloaded page arrives.
  const [overlay, setOverlay] = useState<{ saved: Map<string, Task>; deleted: Set<string> }>(
    () => ({ saved: new Map(), deleted: new Set() }),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page replaces the overlay.
  useEffect(() => setOverlay({ saved: new Map(), deleted: new Set() }), [tasksPage]);
  const savedHere = (saved: Task) => {
    setOverlay((current) => ({ ...current, saved: new Map(current.saved).set(saved.id, saved) }));
    reloadPage();
  };
  const deletedHere = (deleted: Task) => {
    setOverlay((current) => ({ ...current, deleted: new Set(current.deleted).add(deleted.id) }));
    reloadPage();
  };
  const pendingMutation = useRef(false);
  const nextArtifactKey = useRef(0);
  const terminal = task?.status === "accepted" || task?.status === "cancelled";
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task));

  const showTask = useCallback((saved: Task | undefined) => {
    setTask(saved);
    setDraft(draftOf(saved));
    nextArtifactKey.current = saved?.artifacts.length ?? 0;
    setConflict(false);
  }, []);

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const [owners, selected] = await Promise.all([
        api.listBots(workspaceId),
        (taskId ? api.getTask(workspaceId, taskId) : Promise.resolve(undefined)).then(
          (selectedTask) => ({ task: selectedTask, error: undefined }),
          (error: unknown) => ({ task: undefined, error }),
        ),
      ]);
      if (!mounted.current || request !== requestSequence.current) return;
      setBots(owners.filter((owner) => owner.workspaceId === workspaceId));
      // A deep link from another workspace may 404. The new workspace's list must still
      // load, so the operator can select one of its tasks or create a new one.
      if (selected.error) setError(errorMessage(selected.error));
      else if (selected.task && selected.task.workspaceId !== workspaceId) {
        setError(currentI18n().t("tasks.error.otherWorkspace"));
      } else showTask(selected.task);
      setLoaded(true);
    } catch (err) {
      if (mounted.current && request === requestSequence.current) setError(errorMessage(err));
    } finally {
      if (mounted.current && request === requestSequence.current) setLoading(false);
    }
  }, [api, workspaceId, taskId, showTask]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [load]);

  const change = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  const changeArtifact = (key: number, patch: Partial<ArtifactDraft>) => {
    change(
      "artifacts",
      draft.artifacts.map((artifact) =>
        artifact.key === key ? { ...artifact, ...patch } : artifact,
      ),
    );
  };

  const refreshList = async () => {
    if (refreshingList.current || pendingMutation.current || loading) return;
    refreshingList.current = true;
    const sequence = ++listSequence.current;
    setRefreshing(true);
    setError("");
    try {
      reloadPage();
      const owners = await api.listBots(workspaceId);
      if (mounted.current && sequence === listSequence.current) {
        setBots(owners.filter((owner) => owner.workspaceId === workspaceId));
      }
    } catch (err) {
      if (mounted.current && sequence === listSequence.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) {
        refreshingList.current = false;
        setRefreshing(false);
      }
    }
  };

  const mutate = async (operation: () => Promise<Task>, message: string, created = false) => {
    // A ref locks synchronous repeated submits too, before React paints disabled controls.
    if (!mounted.current || pendingMutation.current || conflict || loading) return;
    pendingMutation.current = true;
    listSequence.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await operation();
      if (!mounted.current) return;
      showTask(saved);
      savedHere(saved);
      setNotice(message);
      if (created) navigate(taskHref(saved.id));
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setError(errorMessage(err));
    } finally {
      if (mounted.current) {
        pendingMutation.current = false;
        setBusy(false);
      }
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded || pendingMutation.current || terminal || conflict || loading) return;
    const input = taskInput(draft);
    let invalid = "";
    if (!input.title) invalid = t("tasks.invalid.title");
    else if (
      [input.threadIds ?? [], input.runIds ?? []].some(
        (links) => links.length > 100 || links.some((id) => id.length > 200),
      )
    ) {
      invalid = t("tasks.invalid.links");
    } else if (
      draft.artifacts.some(
        (artifact) =>
          !artifact.label.trim() ||
          !workspaceFileRoot(
            artifact.path.trim(),
            bots.map((owner) => owner.name),
          ),
      )
    ) {
      invalid = t("tasks.invalid.artifact");
    } else if (
      draft.status === "blocked" &&
      (!draft.blockedReason.trim() || !draft.nextAction.trim())
    ) {
      invalid = t("tasks.invalid.blocked");
    } else if (draft.status === "delivered" && draft.artifacts.length === 0) {
      invalid = t("tasks.invalid.delivered");
    }
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!task) {
      const how = triggerRequest(trigger, draft.ownerBotId);
      if ("invalid" in how) {
        setError(t(how.invalid));
        return;
      }
      const key = createKey.current;
      void mutate(
        async () => {
          const saved = await api.createTask(workspaceId, {
            ...input,
            ...how,
            idempotencyKey: key,
          });
          createKey.current = newIdempotencyKey();
          return saved;
        },
        t("tasks.notice.created"),
        true,
      );
    } else if (draft.status !== "accepted") {
      const patch: UpdateTaskInput = {
        ...input,
        version: task.version,
        status: draft.status,
        blockedReason: draft.blockedReason,
        nextAction: draft.nextAction,
      };
      void mutate(() => api.updateTask(workspaceId, task.id, patch), t("tasks.notice.saved"));
    }
  };

  const reload = async () => {
    if (!task || pendingMutation.current || loading) return;
    pendingMutation.current = true;
    listSequence.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const latest = await api.getTask(workspaceId, task.id);
      if (!mounted.current) return;
      showTask(latest);
      savedHere(latest);
      setNotice(t("tasks.notice.reloaded"));
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) {
        pendingMutation.current = false;
        setBusy(false);
      }
    }
  };

  const ownerName = (id: BotId | null) =>
    id ? (bots.find((owner) => owner.id === id)?.name ?? id) : "Unassigned";
  const visibleTasks = pages.items
    .filter((item) => !overlay.deleted.has(item.id))
    .map((item) => overlay.saved.get(item.id) ?? item);
  // The cards and the "n of m" count come from the Gateway's counts, never from a page.
  const counts = tasksPage?.statusCounts;
  const countOf = (statuses: readonly TaskStatus[]) =>
    counts ? statuses.reduce((sum, status) => sum + counts[status], 0) : undefined;
  const allCount = countOf(TASK_STATUSES);
  const listed = tasksPage?.total;
  const listReady = loaded && tasksPage !== undefined && !pages.loading;

  return (
    <section className="tasks-screen page-container">
      <header className="tasks-heading">
        <div>
          <span className="eyebrow">{workspace.name}</span>
          <h1>
            <ClipboardList size={24} aria-hidden="true" /> {t("tasks.title")}
          </h1>
          <p className="muted">{t("tasks.intro")}</p>
        </div>
        {canEditTasks ? (
          <ButtonLink href={taskHref()} variant="primary" className="task-new-link">
            <Plus size={16} /> {t("tasks.newTask")}
          </ButtonLink>
        ) : null}
      </header>
      <div className="task-metrics">
        <MetricCard
          className="task-metric-card"
          label={t("tasks.metrics.open")}
          value={countOf(["planned", "in_progress", "blocked", "delivered"]) ?? "—"}
          detail={<span className="muted small">{t("tasks.metrics.openDetail")}</span>}
        />
        <MetricCard
          className="task-metric-card"
          label={t("tasks.metrics.attention")}
          value={countOf(["blocked", "delivered"]) ?? "—"}
          detail={<span className="muted small">{t("tasks.metrics.attentionDetail")}</span>}
        />
        <MetricCard
          className="task-metric-card"
          label={t("tasks.status.acceptedShort")}
          value={countOf(["accepted"]) ?? "—"}
          detail={<span className="muted small">{t("tasks.metrics.acceptedDetail")}</span>}
        />
      </div>
      <div className="tasks-layout">
        <aside className="task-list" aria-label={t("tasks.list")}>
          <div className="task-list-heading">
            <h2>
              {t("tasks.listTitle")}
              <span className="muted small">
                {allCount === undefined || listed === undefined
                  ? null
                  : filter === "all" && !search
                    ? t("tasks.countShort", { count: allCount })
                    : t("tasks.countFiltered", { count: listed, total: allCount })}
              </span>
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("tasks.refresh")}
              title={t("tasks.refreshTitle")}
              disabled={busy || loading || refreshing}
              loading={refreshing}
              onClick={() => void refreshList()}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
          </div>
          <Input
            aria-label={t("tasks.search")}
            placeholder={t("tasks.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Select
            label={t("tasks.filterStatus")}
            value={filter}
            onValueChange={(value) => setFilter(value)}
            options={[
              {
                value: "all",
                label: t("tasks.filter.all"),
              },
              ...TASK_STATUSES.map((status) => ({
                value: status,
                label: t(STATUS_LABELS[status]),
              })),
            ]}
          />
          {loading || (pages.loading && tasksPage === undefined) ? (
            <p className="muted">{t("tasks.loading")}</p>
          ) : null}
          {pages.error && !loading ? (
            <p role="alert" className="error">
              {errorMessage(pages.error)}
            </p>
          ) : null}
          {listReady && allCount === 0 ? (
            <div>
              <p className="muted">{t("tasks.empty")}</p>
              <NextAction
                action="task.create"
                does={t("tasks.empty.does")}
                how={t("tasks.empty.how")}
              />
            </div>
          ) : listReady && visibleTasks.length === 0 ? (
            <p className="muted">{t("tasks.emptyView")}</p>
          ) : null}
          <ul>
            {visibleTasks.map((item) => (
              <li key={item.id}>
                <a
                  href={taskHref(item.id)}
                  className={item.id === task?.id ? "active" : ""}
                  aria-current={item.id === task?.id ? "page" : undefined}
                >
                  <strong>{item.title}</strong>
                  <div className="task-item-meta">
                    <span
                      className="muted small task-owner"
                      title={t("tasks.links.owner", { name: ownerName(item.ownerBotId) })}
                    >
                      {t("tasks.links.owner", { name: ownerName(item.ownerBotId) })}
                    </span>
                    <TaskStatusLabel status={item.status} compact />
                  </div>
                  {item.status === "blocked" ? (
                    <span className="task-blocker">
                      <span className="muted">{t("tasks.reason")} </span>
                      {item.blockedReason}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          <PageBar query={pages} label={t("tasks.pages")} />
        </aside>
        <div className="task-detail">
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
          {(!loaded || (taskId && !task)) && !loading ? (
            <Button type="button" onClick={() => void load()}>
              {t("tasks.retry")}
            </Button>
          ) : null}
          {notice ? <output className="task-notice">{notice}</output> : null}
          {loaded && (!taskId || task) ? (
            <>
              <header className="task-detail-heading">
                <div>
                  <h2>{task ? task.title : t("tasks.detail.new")}</h2>
                  {task ? (
                    <TaskStatusLabel status={task.status} />
                  ) : (
                    <p className="muted small">{t("tasks.detail.startsPlanned")}</p>
                  )}
                </div>
                {task ? (
                  <Button type="button" disabled={busy} onClick={() => void reload()}>
                    {dirty ? t("tasks.detail.reloadDiscard") : t("tasks.detail.reload")}
                  </Button>
                ) : null}
              </header>
              {conflict ? (
                <div className="task-warning" role="alert">
                  {t("tasks.detail.conflict")}
                </div>
              ) : null}
              {task ? (
                <div className="task-record muted small">
                  <span>
                    {t("tasks.record.version", {
                      version: task.version,
                      updated: formatDateTime(task.updatedAt),
                    })}
                  </span>
                  {task.deliveredAt ? (
                    <span>
                      {task.deliveredBy
                        ? t("tasks.record.deliveredBy", {
                            date: formatDateTime(task.deliveredAt),
                            by: deliveredByLabel(task.deliveredBy, actorName),
                          })
                        : t("tasks.record.delivered", { date: formatDateTime(task.deliveredAt) })}
                    </span>
                  ) : null}
                  {task.acceptedAt ? (
                    <span>
                      {t("tasks.record.accepted", {
                        date: formatDateTime(task.acceptedAt),
                        by: acceptedByLabel(task.acceptedBy, actorName),
                      })}
                    </span>
                  ) : null}
                  {task.deliveredBy || task.acceptedBy ? (
                    <details>
                      <summary>{t("actor.audit")}</summary>
                      {task.deliveredBy ? (
                        <p>
                          {t("tasks.status.delivered")}: <code>{task.deliveredBy}</code>
                        </p>
                      ) : null}
                      {task.acceptedBy ? (
                        <p>
                          {t("tasks.status.accepted")}: <code>{task.acceptedBy}</code>
                        </p>
                      ) : null}
                    </details>
                  ) : null}
                </div>
              ) : null}
              {task?.outputSchema ? (
                <JsonBlock
                  label={t("tasks.outputSchema.label")}
                  note={t("tasks.outputSchema.note")}
                  value={task.outputSchema}
                />
              ) : null}
              {task && task.output !== null ? (
                <JsonBlock
                  label={t("tasks.output.label")}
                  note={t("tasks.output.note")}
                  value={task.output}
                />
              ) : null}
              <form
                className="task-form"
                aria-label={task ? t("tasks.form.edit") : t("tasks.form.create")}
                onSubmit={save}
              >
                <RoleNote action="task.edit" does={t("tasks.roleNote")} />
                <fieldset disabled={busy || terminal || !canEditTasks}>
                  <label htmlFor={`${fieldId}-title`}>
                    {t("tasks.form.title")}
                    <Input
                      id={`${fieldId}-title`}
                      value={draft.title}
                      maxLength={200}
                      required
                      onChange={(event) => change("title", event.target.value)}
                    />
                  </label>
                  <label htmlFor={`${fieldId}-description`}>
                    {t("tasks.form.description")}
                    <TextArea
                      id={`${fieldId}-description`}
                      value={draft.description}
                      maxLength={20000}
                      rows={4}
                      onChange={(event) => change("description", event.target.value)}
                    />
                  </label>
                  <div className="task-form-row">
                    <Select
                      label={t("tasks.form.owner")}
                      value={draft.ownerBotId}
                      onValueChange={(value) => change("ownerBotId", value)}
                      disabled={busy || terminal}
                      options={[
                        {
                          value: "",
                          label: t("tasks.unassigned"),
                        },
                        ...bots.map((owner) => ({
                          value: owner.id,
                          label: owner.name,
                        })),
                      ]}
                    />
                    {task && !terminal ? (
                      <Select
                        label={t("tasks.form.status")}
                        value={draft.status}
                        onValueChange={(value) => change("status", value as TaskStatus)}
                        disabled={busy || terminal}
                        options={[
                          ...TASK_STATUSES.filter((status) => status !== "accepted").map(
                            (status) => ({
                              value: status,
                              label: t(STATUS_LABELS[status]),
                            }),
                          ),
                        ]}
                      />
                    ) : null}
                  </div>
                  {!task ? (
                    <TaskTriggerFields draft={trigger} fieldId={fieldId} onChange={setTrigger} />
                  ) : null}
                  {task ? (
                    <>
                      <label htmlFor={`${fieldId}-blockedReason`}>
                        {t("tasks.form.blockedReason")}
                        <TextArea
                          id={`${fieldId}-blockedReason`}
                          value={draft.blockedReason}
                          maxLength={2000}
                          rows={2}
                          onChange={(event) => change("blockedReason", event.target.value)}
                        />
                      </label>
                      <label htmlFor={`${fieldId}-nextAction`}>
                        {t("tasks.form.nextAction")}
                        <TextArea
                          id={`${fieldId}-nextAction`}
                          value={draft.nextAction}
                          maxLength={2000}
                          rows={2}
                          onChange={(event) => change("nextAction", event.target.value)}
                        />
                      </label>
                      <p className="muted small">{t("tasks.form.statusHelp")}</p>
                    </>
                  ) : null}
                  <div className="task-form-row">
                    <label htmlFor={`${fieldId}-threadIds`}>
                      {t("tasks.form.conversationIds")}
                      <TextArea
                        id={`${fieldId}-threadIds`}
                        value={draft.threadIds}
                        rows={2}
                        placeholder={t("tasks.form.onePerLine")}
                        onChange={(event) => change("threadIds", event.target.value)}
                      />
                    </label>
                    <label htmlFor={`${fieldId}-runIds`}>
                      {t("tasks.form.runIds")}
                      <TextArea
                        id={`${fieldId}-runIds`}
                        value={draft.runIds}
                        rows={2}
                        placeholder={t("tasks.form.onePerLine")}
                        onChange={(event) => change("runIds", event.target.value)}
                      />
                    </label>
                  </div>
                  <p className="muted small">{t("tasks.form.linksHelp")}</p>
                  <div className="task-artifact-editor">
                    <h3>{t("tasks.form.artifacts")}</h3>
                    <p className="muted small">{t("tasks.form.artifactsHelp")}</p>
                    {draft.artifacts.map((artifact, index) => (
                      <div className="task-artifact-fields" key={artifact.key}>
                        <label htmlFor={`${fieldId}-${artifact.key}-label`}>
                          {t("tasks.form.artifactLabel", { number: index + 1 })}
                          <Input
                            id={`${fieldId}-${artifact.key}-label`}
                            value={artifact.label}
                            maxLength={200}
                            onChange={(event) =>
                              changeArtifact(artifact.key, { label: event.target.value })
                            }
                          />
                        </label>
                        <label htmlFor={`${fieldId}-${artifact.key}-path`}>
                          {t("tasks.form.artifactPath", { number: index + 1 })}
                          <Input
                            id={`${fieldId}-${artifact.key}-path`}
                            value={artifact.path}
                            maxLength={4096}
                            placeholder={t("tasks.form.artifactPathPlaceholder")}
                            onChange={(event) =>
                              changeArtifact(artifact.key, { path: event.target.value })
                            }
                          />
                        </label>
                        <label htmlFor={`${fieldId}-${artifact.key}-run`}>
                          {t("tasks.form.artifactRunId", { number: index + 1 })}
                          <Input
                            id={`${fieldId}-${artifact.key}-run`}
                            value={artifact.runId}
                            maxLength={200}
                            onChange={(event) =>
                              changeArtifact(artifact.key, { runId: event.target.value })
                            }
                          />
                        </label>
                        <Button
                          type="button"
                          onClick={() =>
                            change(
                              "artifacts",
                              draft.artifacts.filter((item) => item.key !== artifact.key),
                            )
                          }
                        >
                          {t("tasks.form.removeArtifact", { number: index + 1 })}
                        </Button>
                      </div>
                    ))}
                    {!terminal ? (
                      <Button
                        type="button"
                        disabled={draft.artifacts.length >= 50}
                        onClick={() =>
                          change("artifacts", [
                            ...draft.artifacts,
                            { key: nextArtifactKey.current++, label: "", path: "", runId: "" },
                          ])
                        }
                      >
                        <Plus size={15} /> {t("tasks.form.addArtifact")}
                      </Button>
                    ) : null}
                  </div>
                </fieldset>
                {!terminal && canEditTasks ? (
                  <div className="task-actions">
                    <Button
                      type="submit"
                      variant="default"
                      disabled={busy || conflict || (task !== undefined && !dirty)}
                    >
                      {busy
                        ? t("tasks.form.saving")
                        : task
                          ? t("tasks.form.save")
                          : t("tasks.form.create")}
                    </Button>
                    {dirty ? <span className="muted small">{t("tasks.form.unsaved")}</span> : null}
                  </div>
                ) : null}
              </form>
              {task ? (
                <TaskExecutionPanel
                  api={api}
                  workspaceId={workspaceId}
                  task={task}
                  canEdit={canEditTasks}
                  onChanged={(saved) => {
                    showTask(saved);
                    savedHere(saved);
                  }}
                  onDeleted={(deleted) => {
                    deletedHere(deleted);
                    showTask(undefined);
                    setNotice(t("tasks.execution.deleted"));
                    navigate(taskHref());
                  }}
                />
              ) : null}
              {task?.status === "delivered" ? (
                <section className="task-acceptance" aria-label={t("tasks.acceptance.region")}>
                  <h3>{t("tasks.acceptance.heading")}</h3>
                  <p>{t("tasks.acceptance.body")}</p>
                  {dirty ? <p className="muted small">{t("tasks.acceptance.saveFirst")}</p> : null}
                  <Button
                    type="button"
                    variant="default"
                    disabled={busy || conflict || dirty || !canEditTasks}
                    onClick={() =>
                      void mutate(
                        () => api.acceptTask(workspaceId, task.id, task.version),
                        t("tasks.notice.accepted"),
                      )
                    }
                  >
                    {t("tasks.acceptance.accept")}
                  </Button>
                </section>
              ) : null}
              {task && terminal ? (
                <section className="task-acceptance" aria-label={t("tasks.reopen.region")}>
                  <p>{t("tasks.reopen.body")}</p>
                  <div className="task-actions">
                    <Button
                      type="button"
                      disabled={busy || conflict || !canEditTasks}
                      onClick={() =>
                        void mutate(
                          () =>
                            api.updateTask(workspaceId, task.id, {
                              version: task.version,
                              status: "planned",
                            }),
                          t("tasks.notice.reopenedPlanned"),
                        )
                      }
                    >
                      {t("tasks.reopen.planned")}
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || conflict || !canEditTasks}
                      onClick={() =>
                        void mutate(
                          () =>
                            api.updateTask(workspaceId, task.id, {
                              version: task.version,
                              status: "in_progress",
                            }),
                          t("tasks.notice.reopenedInProgress"),
                        )
                      }
                    >
                      {t("tasks.reopen.inProgress")}
                    </Button>
                  </div>
                </section>
              ) : null}
              {task ? (
                <section className="task-linked-records" aria-label={t("tasks.links.region")}>
                  <h3>{t("tasks.links.heading")}</h3>
                  {task.ownerBotId ? (
                    <a href={contactHref(task.ownerBotId)}>
                      {t("tasks.links.owner", { name: ownerName(task.ownerBotId) })}
                    </a>
                  ) : null}
                  {task.threadIds.map((id) => (
                    <a key={id} href={threadHref(id)}>
                      {t("tasks.links.conversation", { id })}
                    </a>
                  ))}
                  {task.runIds.map((id) => (
                    <a key={id} href={runHref(id)}>
                      {t("tasks.links.run", { id })}
                    </a>
                  ))}
                  {task.artifacts.map((artifact, index) => (
                    <div className="task-saved-artifact" key={`${index}:${artifact.path}`}>
                      <h4>{artifact.label}</h4>
                      {artifact.runId ? (
                        <a href={runHref(artifact.runId)}>
                          {t("tasks.links.artifactRun", { id: artifact.runId })}
                        </a>
                      ) : null}
                      <WorkspaceFilePreview
                        api={api}
                        workspaceId={workspaceId}
                        path={artifact.path}
                      />
                    </div>
                  ))}
                  {!task.threadIds.length && !task.runIds.length && !task.artifacts.length ? (
                    <p className="muted">{t("tasks.links.none")}</p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
