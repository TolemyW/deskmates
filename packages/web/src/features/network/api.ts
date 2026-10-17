// Network profiles (ADR-0027 amendment 1): LAN grants the root or an Owner defines and Admins
// select. Every change is published online; the Gateway answers with what each affected proxy
// acknowledged.

import type {
  NetworkOverlap,
  NetworkPreflightResult,
  NetworkProfile,
  NetworkPublication,
  NetworkRule,
  SandboxNetworkSubnet,
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
  /** The root: every profile is listed and editable, and the overlap report is readable. */
  manageAll?: boolean;
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

export interface NetworkOverlapReport {
  /** False when the sandbox provider cannot list its networks. */
  checked: boolean;
  networks: SandboxNetworkSubnet[];
  overlaps: NetworkOverlap[];
}

export interface NetworkApi {
  createNetworkProfile(input: NetworkProfileInput): Promise<NetworkProfile>;
  deleteNetworkProfile(id: string): Promise<NetworkProfileChange>;
  /** Amendment 2 decision 15: LAN targets inside a Docker network of the daemon (root). */
  getNetworkOverlaps(): Promise<NetworkOverlapReport>;
  getWorkspaceNetwork(id: WorkspaceId): Promise<WorkspaceNetworkView>;
  listNetworkProfiles(): Promise<NetworkProfileList>;
  /** Decision 14: one URL probed from the workspace's proxy; changes and stores nothing. */
  preflightWorkspaceNetwork(id: WorkspaceId, url: string): Promise<NetworkPreflightResult>;
  replaceNetworkProfile(
    id: string,
    input: NetworkProfileInput,
    expectedRevision?: number,
  ): Promise<NetworkProfileChange>;
  setWorkspaceNetworkProfiles(
    id: WorkspaceId,
    selections: Array<{ profileId: string; expiresAt?: string }>,
  ): Promise<WorkspaceNetworkChange>;
  /** Decision 13: whether an open-internet workspace may use profiles (Admin). */
  setWorkspaceNetworkSettings(
    id: WorkspaceId,
    profilesOnOpenInternet: boolean,
  ): Promise<{ network: WorkspaceNetworkView }>;
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
    getNetworkOverlaps() {
      return t.json("GET", "/api/network-overlaps");
    },
    getWorkspaceNetwork(id) {
      return t.json("GET", `/api/workspaces/${encodeURIComponent(id)}/network`);
    },
    listNetworkProfiles() {
      return t.json("GET", "/api/network-profiles");
    },
    preflightWorkspaceNetwork(id, url) {
      return t.json("POST", `/api/workspaces/${encodeURIComponent(id)}/network-preflight`, { url });
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
    setWorkspaceNetworkSettings(id, profilesOnOpenInternet) {
      return t.json("PUT", `/api/workspaces/${encodeURIComponent(id)}/network-settings`, {
        profilesOnOpenInternet,
      });
    },
  };
}
