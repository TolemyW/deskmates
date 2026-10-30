// The sections of a workspace's detail page, in display order (ADR-0034 decision 4). A new block
// (auto-approval, an egress profile) is one component file under `detail/` plus one line here.
// A section marked `audience: "tune"` shows only in the tune view (docs/use-and-tune-views.md).

import type { AuthenticatedSessionView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import type { ComponentType } from "react";
import type { ApiClient } from "../../api/client.js";
import type { MembersClient } from "../../api/members-client.js";
import { AppSharesSection } from "../app-shares/app-shares-section.js";
import { DesktopToolsSection } from "../desktop-tools/desktop-tools-section.js";
import { NetworkProfilesSection } from "../network/network-profiles-section.js";
import { WebSearchSection } from "../web-search/web-search-section.js";
import { WorkdirSection } from "../workdir/workdir-section.js";
import { ArchiveSection } from "./detail/archive-section.js";
import { AutoApprovalSection } from "./detail/auto-approval-section.js";
import { WorkspaceLimitsSection } from "./detail/limits-section.js";
import { NameSection } from "./detail/name-section.js";
import { NetworkSection } from "./detail/network-section.js";
import { PeopleSection } from "./detail/people-section.js";
import type { WorkspaceSettingsGroup } from "./workspace-settings.js";

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
  group: WorkspaceSettingsGroup;
  audience?: "tune";
}> = [
  { key: "name", group: "general", Section: NameSection },
  { key: "network", group: "environment", Section: NetworkSection },
  { key: "web-search", group: "environment", Section: WebSearchSection },
  {
    key: "network-profiles",
    group: "environment",
    Section: NetworkProfilesSection,
    audience: "tune",
  },
  { key: "auto-approval", group: "collaboration", Section: AutoApprovalSection },
  { key: "limits", group: "environment", Section: WorkspaceLimitsSection, audience: "tune" },
  { key: "people", group: "collaboration", Section: PeopleSection },
  { key: "workdir", group: "environment", Section: WorkdirSection, audience: "tune" },
  { key: "desktop-tools", group: "environment", Section: DesktopToolsSection, audience: "tune" },
  { key: "apps", group: "collaboration", Section: AppSharesSection },
  { key: "archive", group: "lifecycle", Section: ArchiveSection },
];
