// Task templates and related tasks (ADR-0021 amendment 4). Every route is scoped
// to one workspace; template edits and archiving carry the loaded version.

import type {
  RelatedTaskList,
  TaskTemplate,
  TaskTemplateInput,
  TaskTemplateList,
  UpdateTaskTemplateInput,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query } from "../../platform/http-transport.js";

export interface TaskKindsApi {
  archiveTaskTemplate(workspaceId: WorkspaceId, id: string, version: number): Promise<TaskTemplate>;
  createTaskTemplate(workspaceId: WorkspaceId, input: TaskTemplateInput): Promise<TaskTemplate>;
  listRelatedTasks(workspaceId: WorkspaceId, taskId: string): Promise<RelatedTaskList>;
  /** Built-ins first, then the workspace's own; archived ones only when asked. */
  listTaskTemplates(workspaceId: WorkspaceId, archived?: boolean): Promise<TaskTemplate[]>;
  updateTaskTemplate(
    workspaceId: WorkspaceId,
    id: string,
    input: UpdateTaskTemplateInput,
  ): Promise<TaskTemplate>;
}

export function createTaskKindsApi(t: HttpTransport): TaskKindsApi {
  const ws = (workspaceId: WorkspaceId) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const template = (workspaceId: WorkspaceId, id: string) =>
    `${ws(workspaceId)}/task-templates/${encodeURIComponent(id)}`;
  return {
    async archiveTaskTemplate(workspaceId, id, version) {
      return (
        await t.json<{ template: TaskTemplate }>("DELETE", template(workspaceId, id), { version })
      ).template;
    },
    async createTaskTemplate(workspaceId, input) {
      return (
        await t.json<{ template: TaskTemplate }>("POST", `${ws(workspaceId)}/task-templates`, input)
      ).template;
    },
    listRelatedTasks(workspaceId, taskId) {
      return t.json<RelatedTaskList>(
        "GET",
        `${ws(workspaceId)}/tasks/${encodeURIComponent(taskId)}/related`,
      );
    },
    async listTaskTemplates(workspaceId, archived = false) {
      return (
        await t.json<TaskTemplateList>(
          "GET",
          `${ws(workspaceId)}/task-templates${archived ? query({ archived: 1 }) : ""}`,
        )
      ).templates;
    },
    async updateTaskTemplate(workspaceId, id, input) {
      return (await t.json<{ template: TaskTemplate }>("PATCH", template(workspaceId, id), input))
        .template;
    },
  };
}
