// Network profiles (ADR-0027 amendment 1): LAN grants the root or an Owner defines and Admins
// select. Every change is published online; the Gateway answers with what each affected proxy
// acknowledged.

import type {
  HostResourceActionResult,
  HostResourceReport,
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
  /** ADR-0006 amendment 5: the Docker host's leftover resources and pool headroom (root). */
  getHostResources(): Promise<HostResourceReport>;
  /** Amendment 2 decision 15: LAN targets inside a Docker network of the daemon (root). */
  getNetworkOverlaps(): Promise<NetworkOverlapReport>;
  getWorkspaceNetwork(id: WorkspaceId): Promise<WorkspaceNetworkView>;
  listNetworkProfiles(): Promise<NetworkProfileList>;
  /** Amendment 5 decision 13: put a mismatched workspace back on its own network (root). */
  reattachHostResource(findingId: string): Promise<HostResourceActionResult>;
  /** Amendment 5 decision 13: remove what one finding names (root). */
  removeHostResource(findingId: string): Promise<HostResourceActionResult>;
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
    getHostResources() {
      return t.json("GET", "/api/runtime/resources");
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
    reattachHostResource(findingId) {
      return t.json("POST", "/api/runtime/resources/reattach", { findingId });
    },
    removeHostResource(findingId) {
      return t.json("POST", "/api/runtime/resources/remove", { findingId });
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
