// The workspace credential vault (ADR-0045 decision 2): read the catalog's metadata (every Member),
// and, for an Owner or Admin, create, edit, replace a value, set request definitions, disable and
// delete. No call returns a saved value. A value is sent once, in a request body, and never kept.

import type {
  VaultEntry,
  VaultEntryCreateInput,
  VaultEntryPatch,
  VaultRequestsInput,
  VaultValueInput,
  VaultView,
} from "@deskmates/contracts";
import { type HttpTransport, query } from "../../platform/http-transport.js";

export interface VaultApi {
  getWorkspaceVault(workspaceId: string): Promise<VaultView>;
  createVaultEntry(workspaceId: string, input: VaultEntryCreateInput): Promise<VaultEntry>;
  /** Metadata only: name, purpose, origin, enabled. The value is unchanged. */
  updateVaultEntry(
    workspaceId: string,
    entryId: string,
    patch: VaultEntryPatch,
  ): Promise<VaultEntry>;
  /** The explicit replacement of the value (decision 2). */
  replaceVaultValue(
    workspaceId: string,
    entryId: string,
    input: VaultValueInput,
  ): Promise<VaultEntry>;
  setVaultRequests(
    workspaceId: string,
    entryId: string,
    input: VaultRequestsInput,
  ): Promise<VaultEntry>;
  deleteVaultEntry(workspaceId: string, entryId: string, expectedRevision: number): Promise<void>;
}

export function createVaultApi(t: HttpTransport): VaultApi {
  const base = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/vault`;
  const entry = (id: string, entryId: string) => `${base(id)}/${encodeURIComponent(entryId)}`;
  return {
    async getWorkspaceVault(workspaceId) {
      return (await t.json<{ vault: VaultView }>("GET", base(workspaceId))).vault;
    },
    async createVaultEntry(workspaceId, input) {
      return (await t.json<{ entry: VaultEntry }>("POST", base(workspaceId), input)).entry;
    },
    async updateVaultEntry(workspaceId, entryId, patch) {
      return (await t.json<{ entry: VaultEntry }>("PATCH", entry(workspaceId, entryId), patch))
        .entry;
    },
    async replaceVaultValue(workspaceId, entryId, input) {
      return (
        await t.json<{ entry: VaultEntry }>("PUT", `${entry(workspaceId, entryId)}/value`, input)
      ).entry;
    },
    async setVaultRequests(workspaceId, entryId, input) {
      return (
        await t.json<{ entry: VaultEntry }>("PUT", `${entry(workspaceId, entryId)}/requests`, input)
      ).entry;
    },
    async deleteVaultEntry(workspaceId, entryId, expectedRevision) {
      await t.json("DELETE", `${entry(workspaceId, entryId)}${query({ expectedRevision })}`);
    },
  };
}
