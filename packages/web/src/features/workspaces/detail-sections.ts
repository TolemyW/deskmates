// The sections of a workspace's detail page, in display order (ADR-0034 decision 4). A new block
// (auto-approval, an egress profile) is one component file under `detail/` plus one line here.

import type { AuthenticatedSessionView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import type { ComponentType } from "react";
import type { ApiClient } from "../../api/client.js";
import type { MembersClient } from "../../api/members-client.js";
import { AppSharesSection } from "../app-shares/app-shares-section.js";
import { NetworkProfilesSection } from "../network/network-profiles-section.js";
import { WorkdirSection } from "../workdir/workdir-section.js";
import { ArchiveSection } from "./detail/archive-section.js";
import { AutoApprovalSection } from "./detail/auto-approval-section.js";
import { WorkspaceLimitsSection } from "./detail/limits-section.js";
import { NameSection } from "./detail/name-section.js";
import { NetworkSection } from "./detail/network-section.js";
import { PeopleSection } from "./detail/people-section.js";

export interface DetailSectionProps {
  api: ApiClient;
  /** The workspace as the directory shows it to the caller. */
  entry: WorkspaceDirectoryEntry;
  /** A section that changed the workspace hands back the updated row. */
  onChanged: (entry: WorkspaceDirectoryEntry) => void;
  /** The shell's people client and session, for the People section (ADR-0034 decision 9). */
  shell?: DetailShell | undefined;
}

export interface DetailShell {
  members: MembersClient;
  session: AuthenticatedSessionView;
}

export const WORKSPACE_DETAIL_SECTIONS: ReadonlyArray<{
  key: string;
  Section: ComponentType<DetailSectionProps>;
}> = [
  { key: "name", Section: NameSection },
  { key: "network", Section: NetworkSection },
  { key: "network-profiles", Section: NetworkProfilesSection },
  { key: "auto-approval", Section: AutoApprovalSection },
  { key: "limits", Section: WorkspaceLimitsSection },
  { key: "people", Section: PeopleSection },
  { key: "workdir", Section: WorkdirSection },
  { key: "apps", Section: AppSharesSection },
  { key: "archive", Section: ArchiveSection },
];
