// Network profiles (ADR-0027 amendment 1): root-defined LAN grants, selected per workspace. Every
// change is published online; the Gateway answers with what each affected proxy acknowledged.

import type {
  NetworkProfile,
  NetworkPublication,
  NetworkRule,
  WorkspaceId,
  WorkspaceNetworkSelection,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface NetworkProfileInput {
  name: string;
  description?: string;
  rules: NetworkRule[];
  expiresAt?: string;
}

export interface NetworkProfileList {
  profiles: NetworkProfile[];
  /** What a published change does to open connections; shown before saving. */
  note?: string;
}

export interface NetworkProfileChange {
  profile: NetworkProfile;
  publications: NetworkPublication[];
}

export interface WorkspaceNetworkChange {
  selections: WorkspaceNetworkSelection[];
  publication: NetworkPublication;
  network: WorkspaceNetworkView;
  note?: string;
}

export interface NetworkApi {
  createNetworkProfile(input: NetworkProfileInput): Promise<NetworkProfile>;
  deleteNetworkProfile(id: string): Promise<NetworkProfileChange>;
  getWorkspaceNetwork(id: WorkspaceId): Promise<WorkspaceNetworkView>;
  listNetworkProfiles(): Promise<NetworkProfileList>;
  replaceNetworkProfile(
    id: string,
    input: NetworkProfileInput,
    expectedRevision?: number,
  ): Promise<NetworkProfileChange>;
  setWorkspaceNetworkProfiles(
    id: WorkspaceId,
    selections: Array<{ profileId: string; expiresAt?: string }>,
  ): Promise<WorkspaceNetworkChange>;
}

export function createNetworkApi(t: HttpTransport): NetworkApi {
  return {
    async createNetworkProfile(input) {
      return (await t.json<{ profile: NetworkProfile }>("POST", "/api/network-profiles", input))
        .profile;
    },
    deleteNetworkProfile(id) {
      return t.json("DELETE", `/api/network-profiles/${encodeURIComponent(id)}`);
    },
    getWorkspaceNetwork(id) {
      return t.json("GET", `/api/workspaces/${encodeURIComponent(id)}/network`);
    },
    listNetworkProfiles() {
      return t.json("GET", "/api/network-profiles");
    },
    replaceNetworkProfile(id, input, expectedRevision) {
      return t.json("PUT", `/api/network-profiles/${encodeURIComponent(id)}`, {
        ...input,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
    },
    setWorkspaceNetworkProfiles(id, selections) {
      return t.json("PUT", `/api/workspaces/${encodeURIComponent(id)}/network-profiles`, {
        selections,
      });
    },
  };
}
