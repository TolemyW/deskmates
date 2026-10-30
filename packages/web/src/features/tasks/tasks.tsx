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
  type ThreadSummary,
  type UpdateTaskInput,
  type Workspace,
  type WorkspaceFileItem,
  workspaceFileRoot,
} from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { ButtonLink, EmptyState, Input, PageHeader, TextArea } from "@deskmates/ui";
import { ArrowLeft, ClipboardList, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { ApiError, type RunView } from "../../api/types.js";
import { DeletedObjectState } from "../../components/deleted-object-state.js";
import { Button } from "../../components/ui/button.js";
import { runStatusLabel } from "../../components/ui/pill.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { PageBar } from "../../lib/page-bar.js";
import { type PageResult, usePagedQuery } from "../../lib/use-paged-query.js";
import { contactHref, navigate, runHref, taskHref, threadHref } from "../../router.js";
import { useActorLabel } from "../../state/session-roles.js";
import { NextAction, useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { TaskKindPanel } from "../task-kinds/task-kind-panel.js";
import {
  NO_TEMPLATE,
  TaskTemplateFields,
  type TemplateChoice,
  templateRequest,
} from "../task-kinds/template-fields.js";
import { TaskTemplatesDialog } from "../task-kinds/templates-dialog.js";
import {
  TaskExecutionPanel,
  TaskTriggerFields,
  newIdempotencyKey,
  triggerDraft,
  triggerRequest,
} from "./task-execution.js";
import { TaskOutput } from "./task-output.js";
import { TaskRevision } from "./task-revision.js";
import { useTaskLiveRefresh } from "./use-task-live-refresh.js";

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
  threadIds: string[];
  runIds: string[];
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
    threadIds: [...(task?.threadIds ?? [])],
    runIds: [...(task?.runIds ?? [])],
    artifacts:
      task?.artifacts.map((artifact, key) => ({ ...artifact, key, runId: artifact.runId ?? "" })) ??
      [],
  };
}

function taskInput(draft: TaskDraft): CreateTaskInput {
  return {
    title: draft.title.trim(),
    description: draft.description,
    ownerBotId: (draft.ownerBotId as BotId) || null,
    threadIds: draft.threadIds as ThreadId[],
    runIds: draft.runIds as RunId[],
    artifacts: draft.artifacts.map(
      (artifact): TaskArtifact => ({
        label: artifact.label.trim(),
        path: artifact.path.trim(),
        ...(artifact.runId.trim() ? { runId: artifact.runId.trim() as RunId } : {}),
      }),
    ),
  };
}

function ReferencePicker({
  label,
  choices,
  selected,
  onChange,
}: {
  label: string;
  choices: readonly { id: string; label: string; detail?: string }[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const known = new Set(choices.map((choice) => choice.id));
  const rows: Array<{ id: string; label: string; detail?: string }> = [
    ...choices,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id })),
  ];
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...new Set([...selected, id])] : selected.filter((item) => item !== id));
  return (
    <fieldset className="task-reference-picker">
      <legend>{label}</legend>
      {rows.length === 0 ? (
        <p className="muted small">—</p>
      ) : (
        <div className="task-reference-choices">
          {rows.map((choice) => (
            <label key={choice.id}>
              <input
                type="checkbox"
                checked={selected.includes(choice.id)}
                onChange={(event) => toggle(choice.id, event.target.checked)}
              />
              <span>
                {choice.label}
                {choice.detail ? <small className="muted">{choice.detail}</small> : null}
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
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
  const [listViews, setListViews] = useState<Record<string, TaskListView>>({});
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
      listView={listViews[scope.current.id] ?? EMPTY_LIST_VIEW}
      onListViewChange={(view) => {
        const id = scope.current?.id;
        if (id) setListViews((current) => ({ ...current, [id]: view }));
      }}
    />
  );
}

interface TaskListView {
  filter: string;
  query: string;
}
const EMPTY_LIST_VIEW: TaskListView = { filter: "all", query: "" };

function WorkspaceTasks({
  api,
  workspace,
  taskId,
  listView,
  onListViewChange,
}: {
  api: ApiClient;
  workspace: Workspace;
  taskId: string | undefined;
  listView: TaskListView;
  onListViewChange: (view: TaskListView) => void;
}) {
  const fieldId = useId();
  const workspaceId = workspace.id;
  const creating = taskId === "new";
  const selectedTaskId = creating ? undefined : taskId;
  const actorName = useActorLabel();
  const t = useT();
  // Tasks are the group's: Admins create, edit and accept them; Members read (ADR-0022 amd. 1).
  const canEditTasks = useCan("task.edit").allowed;
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [files, setFiles] = useState<WorkspaceFileItem[]>([]);
  const [task, setTask] = useState<Task>();
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf());
  // ADR-0021 A3a/A3b: how a new task takes effect, and one create key per intended create.
  const [trigger, setTrigger] = useState(triggerDraft);
  // ADR-0021 A4c: an optional template; none sends exactly the request it sent before.
  const [templateChoice, setTemplateChoice] = useState<TemplateChoice>(NO_TEMPLATE);
  // Bumped when the Templates dialog saves or archives, so the create form's picker reloads.
  const [templatesRevision, setTemplatesRevision] = useState(0);
  const createKey = useRef(newIdempotencyKey());
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState<{ field: string; message: string }>();
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const { filter, query } = listView;
  const setFilter = (filter: string) => onListViewChange({ ...listView, filter });
  const setQuery = (query: string) => onListViewChange({ ...listView, query });
  const [search, setSearch] = useState(query.trim());
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const referenceSequence = useRef(0);
  const [referenceErrors, setReferenceErrors] = useState<MessageKey[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
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
  const [revising, setRevising] = useState(false);
  const revisionButton = useRef<HTMLButtonElement | null>(null);
  const nextArtifactKey = useRef(0);
  const terminal = task?.status === "accepted" || task?.status === "cancelled";
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task));
  const latestEditor = useRef({ task, dirty, revising });
  latestEditor.current = { task, dirty, revising };
  const detailRefreshSequence = useRef(0);

  const showTask = useCallback((saved: Task | undefined) => {
    latestEditor.current = { task: saved, dirty: false, revising: false };
    setRevising(false);
    setTask(saved);
    setDraft(draftOf(saved));
    nextArtifactKey.current = saved?.artifacts.length ?? 0;
    setConflict(false);
  }, []);

  const loadReferences = useCallback(async () => {
    const request = ++referenceSequence.current;
    setReferencesLoading(true);
    const [chats, work, assets] = await Promise.allSettled([
      api.listThreads(workspaceId),
      api.listRuns({ workspaceId, limit: 100 }),
      api.listWorkspaceFiles(workspaceId, { offset: 0, limit: 100 }),
    ]);
    if (!mounted.current || request !== referenceSequence.current) return;
    const failures: MessageKey[] = [];
    if (chats.status === "fulfilled")
      setThreads(chats.value.filter((thread) => thread.workspaceId === workspaceId));
    else failures.push("tasks.form.conversationIds");
    if (work.status === "fulfilled") setRuns(work.value.runs);
    else failures.push("tasks.form.runIds");
    if (assets.status === "fulfilled") setFiles(assets.value.items);
    else failures.push("tasks.form.artifacts");
    setReferenceErrors(failures);
    setReferencesLoading(false);
  }, [api, workspaceId]);

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    setLoading(true);
    setError("");
    setMissing(false);
    try {
      const [owners, selected] = await Promise.all([
        api.listBots(workspaceId),
        (selectedTaskId
          ? api.getTask(workspaceId, selectedTaskId)
          : Promise.resolve(undefined)
        ).then(
          (selectedTask) => ({ task: selectedTask, error: undefined }),
          (error: unknown) => ({ task: undefined, error }),
        ),
        loadReferences(),
      ]);
      if (!mounted.current || request !== requestSequence.current) return;
      setBots(owners.filter((owner) => owner.workspaceId === workspaceId));
      // A deep link from another workspace may 404. The new workspace's list must still
      // load, so the operator can select one of its tasks or create a new one.
      if (selected.error instanceof ApiError && selected.error.status === 404) {
        setMissing(true);
        showTask(undefined);
      } else if (selected.error) setError(errorMessage(selected.error));
      else if (selected.task && selected.task.workspaceId !== workspaceId) {
        setError(currentI18n().t("tasks.error.otherWorkspace"));
      } else showTask(selected.task);
      setLoaded(true);
    } catch (err) {
      if (mounted.current && request === requestSequence.current) setError(errorMessage(err));
    } finally {
      if (mounted.current && request === requestSequence.current) setLoading(false);
    }
  }, [api, workspaceId, selectedTaskId, showTask, loadReferences]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      referenceSequence.current += 1;
    };
  }, [load]);

  const change = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
    setValidation(undefined);
  };

  const invalidate = (field: string, message: string) => {
    setValidation({ field, message });
    window.requestAnimationFrame(() => {
      const region = document.querySelector<HTMLElement>(`[data-task-field="${field}"]`);
      for (let ancestor = region?.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      }
      region?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      region?.querySelector<HTMLElement>("input, textarea, button, select")?.focus();
    });
  };
  const fieldError = (field: string) =>
    validation?.field === field ? (
      <p className="error task-field-error" role="alert">
        {validation.message}
      </p>
    ) : null;

  const changeArtifact = (key: number, patch: Partial<ArtifactDraft>) => {
    change(
      "artifacts",
      draft.artifacts.map((artifact) =>
        artifact.key === key ? { ...artifact, ...patch } : artifact,
      ),
    );
  };

  const refreshSelectedTask = async (refreshPage = true) => {
    if (!selectedTaskId || pendingMutation.current || loading) return;
    const sequence = ++detailRefreshSequence.current;
    try {
      const latest = await api.getTask(workspaceId, selectedTaskId);
      if (!mounted.current || sequence !== detailRefreshSequence.current || pendingMutation.current)
        return;
      const editor = latestEditor.current;
      if (
        latest.id !== editor.task?.id ||
        latest.workspaceId !== workspaceId ||
        latest.version <= (editor.task?.version ?? 0)
      )
        return;
      // Retain the old base version and every unsent edit until the person resolves the conflict.
      if (editor.dirty || editor.revising) setConflict(true);
      else showTask(latest);
      setOverlay((current) => ({
        ...current,
        saved: new Map(current.saved).set(latest.id, latest),
      }));
      if (refreshPage) reloadPage();
    } catch (err) {
      if (mounted.current && sequence === detailRefreshSequence.current)
        setError(errorMessage(err));
    }
  };

  useTaskLiveRefresh(task, refreshSelectedTask);

  const refreshList = async () => {
    if (refreshingList.current || pendingMutation.current || loading) return;
    refreshingList.current = true;
    const sequence = ++listSequence.current;
    setRefreshing(true);
    setError("");
    try {
      reloadPage();
      const [owners] = await Promise.all([api.listBots(workspaceId), refreshSelectedTask(false)]);
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
      const field = !input.title
        ? "title"
        : invalid === t("tasks.invalid.links")
          ? "references"
          : invalid === t("tasks.invalid.artifact") || invalid === t("tasks.invalid.delivered")
            ? "artifacts"
            : "blocked";
      invalidate(field, invalid);
      return;
    }
    if (!task) {
      const how = triggerRequest(trigger, draft.ownerBotId);
      if ("invalid" in how) {
        invalidate(how.invalid === "tasks.invalid.owner" ? "owner" : "trigger", t(how.invalid));
        return;
      }
      const key = createKey.current;
      void mutate(
        async () => {
          const saved = await api.createTask(workspaceId, {
            ...input,
            ...how,
            ...templateRequest(templateChoice),
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
  const threadChoices = threads.map((thread) => ({
    id: thread.id,
    label: thread.title,
    detail: thread.kind,
  }));
  const runChoices = runs.map((run) => {
    const conversation = threads.find((thread) => thread.id === run.threadId);
    return {
      id: run.id,
      label: `${runStatusLabel(run.status)} · ${run.id}`,
      ...(conversation ? { detail: conversation.title } : {}),
    };
  });
  const fileOptions = files.map((file) => ({ value: file.path, label: file.path }));

  const GoalEditor = task ? "details" : "div";

  return (
    <section
      className={`tasks-screen page-container${taskId !== undefined ? " has-selection" : ""}${creating ? " is-creating" : ""}`}
    >
      <PageHeader
        title={t("tasks.title")}
        description={t("tasks.intro")}
        action={
          <div className="task-actions">
            <TaskTemplatesDialog
              api={api}
              workspaceId={workspaceId}
              onChanged={() => setTemplatesRevision((n) => n + 1)}
            />
            {canEditTasks && !creating ? (
              <ButtonLink href={taskHref("new")} variant="primary" className="task-new-link">
                <Plus size={16} /> {t("tasks.newTask")}
              </ButtonLink>
            ) : null}
          </div>
        }
      />
      <div className={`tasks-layout${taskId === undefined ? " list-only" : ""}`}>
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
          <div className="task-list-tools">
            <Input
              aria-label={t("tasks.search")}
              placeholder={t("tasks.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Select
              aria-label={t("tasks.filterStatus")}
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
          </div>
          {loading || (pages.loading && tasksPage === undefined) ? (
            <p className="muted">{t("tasks.loading")}</p>
          ) : null}
          {pages.error && !loading ? (
            <p role="alert" className="error">
              {errorMessage(pages.error)}
            </p>
          ) : null}
          {listReady && allCount === 0 ? (
            <EmptyState icon={<ClipboardList size={22} />} title={t("tasks.empty")}>
              {!canEditTasks ? (
                <NextAction
                  action="task.create"
                  does={t("tasks.empty.does")}
                  how={t("tasks.empty.how")}
                />
              ) : null}
            </EmptyState>
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
        {taskId !== undefined ? (
          <div className="task-detail">
            <a href={taskHref()} className="task-back-link">
              <ArrowLeft size={16} aria-hidden="true" />
              {t("tasks.backToList")}
            </a>
            {missing ? <DeletedObjectState /> : null}
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
            {!missing && (!loaded || (selectedTaskId && !task)) && !loading ? (
              <Button type="button" onClick={() => void load()}>
                {t("tasks.retry")}
              </Button>
            ) : null}
            {!missing && notice ? <output className="task-notice">{notice}</output> : null}
            {!missing && loaded && (creating || task) ? (
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
                  <div className="task-actions task-primary-actions">
                    {task?.status === "delivered" ? (
                      <>
                        <Button
                          type="button"
                          variant="default"
                          disabled={busy || revising || conflict || dirty || !canEditTasks}
                          onClick={() =>
                            void mutate(
                              () => api.acceptTask(workspaceId, task.id, task.version),
                              t("tasks.notice.accepted"),
                            )
                          }
                        >
                          {t("tasks.acceptance.accept")}
                        </Button>
                        <Button
                          type="button"
                          disabled={busy || conflict || dirty || !canEditTasks}
                          ref={revisionButton}
                          onClick={() => setRevising(true)}
                        >
                          {t("tasks.acceptance.requestChanges")}
                        </Button>
                      </>
                    ) : null}
                    {task && conflict ? (
                      <Button type="button" disabled={busy} onClick={() => void reload()}>
                        {t("tasks.detail.reloadDiscard")}
                      </Button>
                    ) : null}
                  </div>
                </header>
                {conflict ? (
                  <div className="task-warning" role="alert">
                    {t("tasks.detail.conflict")}
                  </div>
                ) : null}
                {task ? (
                  <>
                    {revising && task.status === "delivered" ? (
                      <TaskRevision
                        key={task.id}
                        api={api}
                        workspaceId={workspaceId}
                        task={task}
                        onCancel={() => {
                          setRevising(false);
                          revisionButton.current?.focus();
                        }}
                        onConflict={() => setConflict(true)}
                        onChanged={(saved) => {
                          showTask(saved);
                          savedHere(saved);
                          setNotice(t("tasks.revision.started"));
                        }}
                      />
                    ) : null}
                    <div className="task-goal-overview">
                      {task.description ? <p>{task.description}</p> : null}
                      {task.ownerBotId ? (
                        <a href={contactHref(task.ownerBotId)}>
                          {t("tasks.links.owner", { name: ownerName(task.ownerBotId) })}
                        </a>
                      ) : (
                        <span className="muted small">{t("tasks.unassigned")}</span>
                      )}
                      {task.status === "blocked" ? (
                        <div className="task-warning">
                          <p>{task.blockedReason}</p>
                          <p>{task.nextAction}</p>
                        </div>
                      ) : null}
                    </div>
                    {task.output !== null ? (
                      <TaskOutput output={task.output} schema={task.outputSchema} />
                    ) : null}
                    <TaskExecutionPanel
                      api={api}
                      workspaceId={workspaceId}
                      task={task}
                      canEdit={canEditTasks}
                      canRun={!busy && !revising && !dirty && !conflict}
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
                  </>
                ) : null}
                {canEditTasks ? (
                  <GoalEditor className="task-goal-editor">
                    {task ? <summary>{t("tasks.editGoal")}</summary> : null}
                    <form
                      className="task-form"
                      aria-label={task ? t("tasks.form.edit") : t("tasks.form.create")}
                      onSubmit={save}
                    >
                      <fieldset disabled={busy || revising || terminal}>
                        <label htmlFor={`${fieldId}-title`} data-task-field="title">
                          {t("tasks.form.title")}
                          <Input
                            id={`${fieldId}-title`}
                            value={draft.title}
                            maxLength={200}
                            required
                            onChange={(event) => change("title", event.target.value)}
                          />
                          {fieldError("title")}
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
                          <div data-task-field="owner">
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
                            {fieldError("owner")}
                          </div>
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
                          <div data-task-field="trigger">
                            <TaskTriggerFields
                              draft={trigger}
                              fieldId={fieldId}
                              onChange={(next) => {
                                setTrigger(next);
                                setValidation(undefined);
                              }}
                            />
                            {fieldError("trigger")}
                          </div>
                        ) : null}
                        {!task ? (
                          <TaskTemplateFields
                            api={api}
                            workspaceId={workspaceId}
                            fieldId={fieldId}
                            value={templateChoice}
                            onChange={setTemplateChoice}
                            revision={templatesRevision}
                          />
                        ) : null}
                        {task ? (
                          <div data-task-field="blocked">
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
                            {fieldError("blocked")}
                          </div>
                        ) : null}
                        <details className="task-advanced">
                          <summary>{t("tasks.advanced.heading")}</summary>
                          <div className="task-advanced-body">
                            <p className="muted small">{t("tasks.goal.note")}</p>
                            {referenceErrors.length > 0 ? (
                              <div>
                                <p role="alert" className="error">
                                  {t("tasks.references.failed", {
                                    items: referenceErrors.map((key) => t(key)).join(", "),
                                  })}
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={referencesLoading}
                                  onClick={() => void loadReferences()}
                                >
                                  {t("tasks.references.retry")}
                                </Button>
                              </div>
                            ) : null}
                            <div className="task-form-row" data-task-field="references">
                              <ReferencePicker
                                label={t("tasks.form.conversationIds")}
                                choices={threadChoices}
                                selected={draft.threadIds}
                                onChange={(ids) => change("threadIds", ids)}
                              />
                              <ReferencePicker
                                label={t("tasks.form.runIds")}
                                choices={runChoices}
                                selected={draft.runIds}
                                onChange={(ids) => change("runIds", ids)}
                              />
                              {fieldError("references")}
                            </div>
                            <p className="muted small">{t("tasks.form.linksHelp")}</p>
                            <div className="task-artifact-editor" data-task-field="artifacts">
                              <h3>{t("tasks.form.artifacts")}</h3>
                              <p className="muted small">{t("tasks.form.artifactsHelp")}</p>
                              {fieldError("artifacts")}
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
                                  <Select
                                    label={t("tasks.form.artifactPath", { number: index + 1 })}
                                    value={artifact.path}
                                    onValueChange={(path) => changeArtifact(artifact.key, { path })}
                                    options={[
                                      { value: "", label: t("tasks.form.artifactPathPlaceholder") },
                                      ...(artifact.path &&
                                      !files.some((file) => file.path === artifact.path)
                                        ? [{ value: artifact.path, label: artifact.path }]
                                        : []),
                                      ...fileOptions,
                                    ]}
                                  />
                                  <Select
                                    label={t("tasks.form.artifactRunId", { number: index + 1 })}
                                    value={artifact.runId}
                                    onValueChange={(runId) =>
                                      changeArtifact(artifact.key, { runId })
                                    }
                                    options={[
                                      { value: "", label: "—" },
                                      ...(artifact.runId &&
                                      !runs.some((run) => run.id === artifact.runId)
                                        ? [{ value: artifact.runId, label: artifact.runId }]
                                        : []),
                                      ...runChoices.map((run) => ({
                                        value: run.id,
                                        label: run.label,
                                      })),
                                    ]}
                                  />
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
                                      {
                                        key: nextArtifactKey.current++,
                                        label: "",
                                        path: "",
                                        runId: "",
                                      },
                                    ])
                                  }
                                >
                                  <Plus size={15} /> {t("tasks.form.addArtifact")}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </details>
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
                          {dirty ? (
                            <span className="muted small">{t("tasks.form.unsaved")}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </form>
                  </GoalEditor>
                ) : null}
                {task?.kind ? (
                  <details className="task-kind-details">
                    <summary>{t("taskKinds.panel.heading", { name: task.kind.name })}</summary>
                    <TaskKindPanel api={api} workspaceId={workspaceId} task={task} />
                  </details>
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
                  <details className="task-system-details">
                    <summary>{t("tasks.system.heading")}</summary>
                    <div className="task-system-body">
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
                              : t("tasks.record.delivered", {
                                  date: formatDateTime(task.deliveredAt),
                                })}
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
                      {task.outputSchema ? (
                        <JsonBlock
                          label={t("tasks.outputSchema.label")}
                          note={t("tasks.outputSchema.note")}
                          value={task.outputSchema}
                        />
                      ) : null}
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
                            <code>{artifact.path}</code>
                          </div>
                        ))}
                        {!task.threadIds.length && !task.runIds.length && !task.artifacts.length ? (
                          <p className="muted">{t("tasks.links.none")}</p>
                        ) : null}
                      </section>
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
