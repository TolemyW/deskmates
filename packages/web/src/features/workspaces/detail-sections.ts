// The sections of a workspace's detail page, in display order (ADR-0034 decision 4). A new block
// (auto-approval, an egress profile) is one component file under `detail/` plus one line here.

import type { WorkspaceDirectoryEntry } from "@deskmates/contracts";
import type { ComponentType } from "react";
import type { ApiClient } from "../../api/client.js";
import { ArchiveSection } from "./detail/archive-section.js";
import { NameSection } from "./detail/name-section.js";
import { NetworkSection } from "./detail/network-section.js";
import { PeopleSection } from "./detail/people-section.js";

export interface DetailSectionProps {
  api: ApiClient;
  /** The workspace as the directory shows it to the caller. */
  entry: WorkspaceDirectoryEntry;
  /** A section that changed the workspace hands back the updated row. */
  onChanged: (entry: WorkspaceDirectoryEntry) => void;
}

export const WORKSPACE_DETAIL_SECTIONS: ReadonlyArray<{
  key: string;
  Section: ComponentType<DetailSectionProps>;
}> = [
  { key: "name", Section: NameSection },
  { key: "network", Section: NetworkSection },
  { key: "people", Section: PeopleSection },
  { key: "archive", Section: ArchiveSection },
];
