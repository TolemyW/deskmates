// The operator `ApiClient`: one composition of the per-feature Gateway API modules
// (packages/gateway/docs/http-api.md). Each feature owns its endpoints in
// `src/features/<feature>/api.ts`; all of them send through one `HttpTransport`
// (`src/platform/http-transport.ts`). Paths are relative so the Vite dev proxy and a same-origin
// deployment both work. A new endpoint goes in its feature's `api.ts`; a new feature domain adds
// one sorted line to each of the three lists below (import, `ApiClient`, `createApiClient`).

import { type ApprovalsApi, createApprovalsApi } from "../features/approvals/api.js";
import { type BoardApi, createBoardApi } from "../features/board/api.js";
import { type ChatsApi, createChatsApi } from "../features/chats/api.js";
import { type ComputerApi, createComputerApi } from "../features/computer/api.js";
import { type ContactsApi, createContactsApi } from "../features/contacts/api.js";
import { type CostsApi, createCostsApi } from "../features/costs/api.js";
import { type FilesApi, createFilesApi } from "../features/files/api.js";
import { type IntegrationsApi, createIntegrationsApi } from "../features/integrations/api.js";
import { type KnowledgeApi, createKnowledgeApi } from "../features/knowledge/api.js";
import { type LimitsApi, createLimitsApi } from "../features/limits/api.js";
import { type NetworkApi, createNetworkApi } from "../features/network/api.js";
import { type RunsApi, createRunsApi } from "../features/runs/api.js";
import { type SkillsApi, createSkillsApi } from "../features/skills/api.js";
import { type TasksApi, createTasksApi } from "../features/tasks/api.js";
import { type TrashApi, createTrashApi } from "../features/trash/api.js";
import { type WorkspacesApi, createWorkspacesApi } from "../features/workspaces/api.js";
import { type HttpTransportOptions, createHttpTransport } from "../platform/http-transport.js";
import { type ConfigApi, createConfigApi } from "./config-api.js";

// Request and view types screens import from here; they live next to their endpoints.
export type { ApprovalFilter } from "../features/approvals/api.js";
export type { CreateThreadInput } from "../features/chats/api.js";
export type { CreateBotInput } from "../features/contacts/api.js";
export type { IntegrationsStatus } from "../features/integrations/api.js";
export type { LearnedMemoryEntry } from "../features/knowledge/api.js";
export type { InstallSkillInput, InstalledSkill, SkillsView } from "../features/skills/api.js";
export type { CreateWorkspaceInput } from "../features/workspaces/api.js";
export type { MemoryView } from "./types.js";

/** Every Gateway operator endpoint the screens call: one intersection member per domain, sorted. */
export type ApiClient = ApprovalsApi &
  BoardApi &
  ChatsApi &
  ComputerApi &
  ConfigApi &
  ContactsApi &
  CostsApi &
  FilesApi &
  IntegrationsApi &
  KnowledgeApi &
  LimitsApi &
  NetworkApi &
  RunsApi &
  SkillsApi &
  TasksApi &
  TrashApi &
  WorkspacesApi;

/**
 * `baseUrl`, an injected `fetch`, the session's CSRF token getter (ADR-0022 P1), the 401 signal,
 * and the tenant this client acts in (ADR-0022 P4). The tenant is fixed per client: switching
 * tenant builds a new client and remounts the screens, so a late response to the old tenant's
 * request can only reach screens that are gone.
 */
export type ApiClientOptions = Omit<HttpTransportOptions, "cache">;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const t = createHttpTransport(options);
  return {
    ...createApprovalsApi(t),
    ...createBoardApi(t),
    ...createChatsApi(t),
    ...createComputerApi(t),
    ...createConfigApi(t),
    ...createContactsApi(t),
    ...createCostsApi(t),
    ...createFilesApi(t),
    ...createIntegrationsApi(t),
    ...createKnowledgeApi(t),
    ...createLimitsApi(t),
    ...createNetworkApi(t),
    ...createRunsApi(t),
    ...createSkillsApi(t),
    ...createTasksApi(t),
    ...createTrashApi(t),
    ...createWorkspacesApi(t),
  };
}

/** The client the screens use; tests build their own with a mocked `fetch`. */
export const api: ApiClient = createApiClient();
