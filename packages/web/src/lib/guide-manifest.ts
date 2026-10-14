// The operator guide bundled into the web release (issue #28). Every page of docs/guide/ is
// imported here by name, so the build carries exactly the guide of the commit it was built from:
// no runtime fetch, no Gateway documentation service, no path the browser can choose.
// `guide-manifest.test.ts` fails when docs/guide/ and this list disagree.

import index from "../../../../docs/guide/README.md?raw";
import approvals from "../../../../docs/guide/approvals.md?raw";
import bots from "../../../../docs/guide/bots.md?raw";
import channels from "../../../../docs/guide/channels.md?raw";
import chatsAndGroups from "../../../../docs/guide/chats-and-groups.md?raw";
import costs from "../../../../docs/guide/costs.md?raw";
import gettingStarted from "../../../../docs/guide/getting-started.md?raw";
import integrationsAndConnectors from "../../../../docs/guide/integrations-and-connectors.md?raw";
import peopleAndRoles from "../../../../docs/guide/people-and-roles.md?raw";
import tasks from "../../../../docs/guide/tasks.md?raw";
import usingDeskmatesFromAnotherAgent from "../../../../docs/guide/using-deskmates-from-another-agent.md?raw";
import workspaces from "../../../../docs/guide/workspaces.md?raw";
import { GUIDE_INDEX, type GuidePage } from "./guide.js";

/** A page of the bundled manual: the index or a topic page. */
export type GuidePageId = typeof GUIDE_INDEX | GuidePage;

export interface GuideEntry {
  id: GuidePageId;
  /** The page's first heading. */
  title: string;
  /** The page's Markdown, as written in docs/guide/. English; no translation is bundled yet. */
  source: string;
}

function entry(id: GuidePageId, source: string): GuideEntry {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(source);
  return { id, title: heading?.[1] ?? id, source };
}

/** The pages in reading order: the index, then the order of its table. */
export const GUIDE_ENTRIES: readonly GuideEntry[] = [
  entry(GUIDE_INDEX, index),
  entry("getting-started", gettingStarted),
  entry("workspaces", workspaces),
  entry("bots", bots),
  entry("chats-and-groups", chatsAndGroups),
  entry("tasks", tasks),
  entry("approvals", approvals),
  entry("integrations-and-connectors", integrationsAndConnectors),
  entry("channels", channels),
  entry("costs", costs),
  entry("people-and-roles", peopleAndRoles),
  entry("using-deskmates-from-another-agent", usingDeskmatesFromAnotherAgent),
];

/**
 * Images and other files the guide may reference, by their path under docs/guide/, mapped to the
 * URL the build gives them. The guide has none today; a new one is imported here (`?url`) like a
 * page, and nothing outside this record is ever loaded.
 */
export const GUIDE_ASSETS: Readonly<Record<string, string>> = {};

const BY_ID = new Map<string, GuideEntry>(GUIDE_ENTRIES.map((e) => [e.id, e]));

export function isGuidePageId(id: string): id is GuidePageId {
  return BY_ID.has(id);
}

export function guideEntry(id: GuidePageId): GuideEntry {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`no guide page ${id}`);
  return found;
}

/**
 * An identity of the bundled guide text: FNV-1a over every page's id and source, as 8 hex digits.
 * It tells two builds' manuals apart; it is not a security hash.
 */
export function guideFingerprint(entries: readonly GuideEntry[] = GUIDE_ENTRIES): string {
  let hash = 0x811c9dc5;
  for (const { id, source } of entries) {
    for (const text of [id, "\u0000", source, "\u0000"]) {
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
