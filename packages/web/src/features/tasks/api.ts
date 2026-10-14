// Workspace tasks (ADR-0021): every route is scoped to one workspace; updates carry the version.
// Amendment 3: create carries its trigger, Run and delete are explicit acts with their own routes.

import type {
  CreateTaskRequest,
  Task,
  TaskDetailResponse,
  TaskListPage,
  TaskStatus,
  TaskSubmitResponse,
  UpdateTaskInput,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface TasksApi {
  acceptTask(workspaceId: WorkspaceId, id: string, version: number): Promise<Task>;
  createTask(workspaceId: WorkspaceId, input: CreateTaskRequest): Promise<Task>;
  deleteTask(workspaceId: WorkspaceId, id: string, version: number): Promise<void>;
  getTask(workspaceId: WorkspaceId, id: string): Promise<Task>;
  getTaskDetail(workspaceId: WorkspaceId, id: string): Promise<TaskDetailResponse>;
  /**
   * One page of the workspace's tasks, status and search applied by the Gateway, with the total
   * and the workspace's counts by status (#113). Without filters, the first page.
   */
  listTasks(
    workspaceId: WorkspaceId,
    filters?: { status?: TaskStatus; q?: string; offset?: number; limit?: number },
  ): Promise<TaskListPage>;
  runTask(
    workspaceId: WorkspaceId,
    id: string,
    version: number,
    idempotencyKey: string,
  ): Promise<TaskSubmitResponse>;
  updateTask(workspaceId: WorkspaceId, id: string, input: UpdateTaskInput): Promise<Task>;
}

export function createTasksApi(t: HttpTransport): TasksApi {
  const tasks = (workspaceId: WorkspaceId) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`;
  const one = (workspaceId: WorkspaceId, id: string) =>
    `${tasks(workspaceId)}/${encodeURIComponent(id)}`;
  return {
    async acceptTask(workspaceId, id, version) {
      return (await t.json<{ task: Task }>("POST", `${one(workspaceId, id)}/accept`, { version }))
        .task;
    },
    async createTask(workspaceId, input) {
      return (await t.json<TaskSubmitResponse>("POST", tasks(workspaceId), stripUndefined(input)))
        .task;
    },
    async deleteTask(workspaceId, id, version) {
      await t.json<{ deleted: true }>("DELETE", one(workspaceId, id), { version });
    },
    async getTask(workspaceId, id) {
      return (await t.json<TaskDetailResponse>("GET", one(workspaceId, id))).task;
    },
    async getTaskDetail(workspaceId, id) {
      return t.json<TaskDetailResponse>("GET", one(workspaceId, id));
    },
    listTasks(workspaceId, filters = {}) {
      return t.json<TaskListPage>("GET", `${tasks(workspaceId)}${query({ ...filters })}`);
    },
    async runTask(workspaceId, id, version, idempotencyKey) {
      return t.json<TaskSubmitResponse>("POST", `${one(workspaceId, id)}/run`, {
        version,
        idempotencyKey,
      });
    },
    async updateTask(workspaceId, id, input) {
      return (await t.json<{ task: Task }>("PATCH", one(workspaceId, id), stripUndefined(input)))
        .task;
    },
  };
}
