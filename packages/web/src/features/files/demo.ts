// Demo routes of the Files page: the collection of ADR-0014 amendment A4 built from delivered
// tasks (legacy, unverified), human attachments (inputs) and a few demo-only verified
// publications, and the text of files the scripted bots wrote. The demo verifies nothing: its
// publication digests are placeholders.

import {
  type BotDefinition,
  type FilePublication,
  type FileReference,
  type FileVerification,
  type WorkspaceFileCollectionPage,
  type WorkspaceId,
  fileKindOf,
  parseFileCollectionQuery,
  workspaceFileRoot,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, ok } from "../../demo/result.js";
import { type DemoState, minutesAgo, sleep } from "../../demo/state.js";
import { demoUploadReferences, uploadRoute } from "./demo-uploads.js";

export const demo: DemoFeature = { route };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, query: q } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  const upload = uploadRoute(req, s);
  if (upload) return upload;
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/assets$/)) && method === "GET")
    return assets(s, x[1] as WorkspaceId, q);
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/files$/))) {
    if (demoFilesState() === "stopped")
      return {
        status: 404,
        json: {
          code: "not_found",
          message: "Workspace is not running; no file was read",
          details: { reason: "workspace_not_running" },
        },
      };
    const file = s.files.get(q.get("path") ?? "");
    if (file === undefined)
      return {
        status: 404,
        json: {
          code: "not_found",
          message: "This demo keeps only the files its bots wrote.",
          details: {},
        },
      };
    return { status: 200, blob: new Blob([file], { type: "text/plain" }) };
  }
  return undefined;
}

/**
 * The Files collection as the Gateway builds it (ADR-0014 amendment A4): publications, human
 * attachments and legacy delivered task artifacts, plus a few demo-only publications so every
 * type and colliding names show up. Bot mentions in chat are not listed.
 */
async function assets(s: DemoState, workspaceId: WorkspaceId, q: URLSearchParams): Promise<Result> {
  const state = demoFilesState();
  if (state === "loading") await sleep(600_000);
  if (state === "error")
    return {
      status: 500,
      json: { code: "internal", message: "Demo: the files list failed", details: {} },
    };
  const parsed = parseFileCollectionQuery(Object.fromEntries(q));
  if (!parsed.ok)
    return {
      status: 400,
      json: { code: "validation", message: `Invalid ${parsed.field}`, details: {} },
    };
  const query = parsed.query;
  const bots = s.bots.filter((b) => b.workspaceId === workspaceId);
  const botNames = bots.map((b) => b.name);
  const byPath = new Map<string, DemoEntry>();
  const add: DemoAdd = (path, ref, bot, verification, publication) => {
    if (workspaceFileRoot(path, botNames) === undefined) return;
    const entry = byPath.get(path) ?? { refs: [], bot: false, verification };
    entry.refs.push(ref);
    entry.bot ||= bot;
    if (RANK[verification] > RANK[entry.verification]) entry.verification = verification;
    if (publication) entry.publication ??= publication;
    byPath.set(path, entry);
  };
  if (state !== "empty") {
    for (const task of s.tasks.values()) {
      if (task.workspaceId !== workspaceId) continue;
      // Only delivered work is a result; the demo has no publications for it, so it is legacy.
      if (task.status !== "delivered" && task.status !== "accepted") continue;
      for (const artifact of task.artifacts) {
        const run = artifact.runId ? s.runs.get(artifact.runId) : undefined;
        const bot = run ? bots.find((b) => b.id === run.botId) : undefined;
        add(
          artifact.path,
          {
            kind: "task_artifact",
            at: task.deliveredAt ?? task.updatedAt,
            taskId: task.id,
            taskTitle: task.title,
            label: artifact.label,
            ...(run ? { runId: run.id } : {}),
            ...(bot ? { botId: bot.id, botName: bot.name } : {}),
            usedInDelivery: true as const,
          },
          run !== undefined,
          "unverified",
        );
      }
    }
    for (const thread of s.threads.filter((t) => t.workspaceId === workspaceId)) {
      for (const msg of s.messages.get(thread.id) ?? []) {
        // Inputs a person supplied; bot attachments and paths stay in their chat (A4).
        if (msg.authorKind !== "human") continue;
        for (const attachment of msg.attachments)
          add(
            attachment.ref,
            {
              kind: "message_attachment",
              at: msg.ts,
              threadId: thread.id,
              threadTitle: thread.title,
              messageId: msg.id,
              authorKind: "human",
              label: attachment.name,
            },
            false,
            "input",
          );
      }
    }
    for (const uploaded of demoUploadReferences(workspaceId))
      add(uploaded.path, uploaded.ref, false, "input");
    if (workspaceId === s.workspaces[0]?.id) demoAssetReferences(s, add, bots);
  }
  const kindOf = (path: string) => fileKindOf(path);
  const sourceOf = (entry: DemoEntry) =>
    entry.verification === "input" ? "uploaded" : entry.bot ? "bot" : "unknown";
  const entries = [...byPath.entries()];
  const searchMatches = ([path, entry]: (typeof entries)[number]) =>
    query.q === "" ||
    path.toLowerCase().includes(query.q) ||
    entry.refs.some((ref) => ref.label?.toLowerCase().includes(query.q));
  const typeMatches = ([path]: (typeof entries)[number]) =>
    query.type === "all" || kindOf(path) === query.type;
  const sourceMatches = ([, entry]: (typeof entries)[number]) =>
    query.source === "all" || sourceOf(entry) === query.source;
  const facets: WorkspaceFileCollectionPage["facets"] = {
    types: { documents: 0, images: 0, web: 0, other: 0 },
    sources: { bot: 0, uploaded: 0, unknown: 0 },
  };
  for (const entry of entries) {
    if (searchMatches(entry) && sourceMatches(entry)) facets.types[kindOf(entry[0])] += 1;
    if (searchMatches(entry) && typeMatches(entry)) facets.sources[sourceOf(entry[1])] += 1;
  }
  const matches = entries
    .filter((entry) => typeMatches(entry) && sourceMatches(entry) && searchMatches(entry))
    .map(([path, entry]) => {
      const refs = [...entry.refs].sort((a, b) => b.at.localeCompare(a.at));
      return {
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: kindOf(path),
        source: sourceOf(entry),
        verification: entry.verification,
        ...(entry.publication ? { publication: entry.publication } : {}),
        lastReferencedAt: refs[0]?.at ?? "",
        referenceCount: refs.length,
        references: refs.slice(0, 20),
      };
    })
    .sort(
      (a, b) =>
        b.lastReferencedAt.localeCompare(a.lastReferencedAt) || a.path.localeCompare(b.path),
    );
  return ok({
    scope: "published-results-and-inputs",
    items: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
    offset: query.offset,
    limit: query.limit,
    truncated: state === "truncated",
    facets,
  });
}

interface DemoEntry {
  refs: FileReference[];
  bot: boolean;
  verification: FileVerification;
  publication?: FilePublication;
}

type DemoAdd = (
  path: string,
  ref: FileReference,
  bot: boolean,
  verification: FileVerification,
  publication?: FilePublication,
) => void;

const RANK: Record<FileVerification, number> = { input: 0, unverified: 1, verified: 2 };

/** Demo-only publications: an image, a web page and two same-named files, plus an input. */
function demoAssetReferences(s: DemoState, addRef: DemoAdd, bots: BotDefinition[]): void {
  const thread = s.threads.find((t) => t.workspaceId === bots[0]?.workspaceId);
  const byName = (name: string) => bots.find((b) => b.name === name);
  const said = (name: string, minutes: number): FileReference => {
    const bot = byName(name);
    return {
      kind: "publication",
      at: minutesAgo(minutes),
      taskTitle: "Demo delivery",
      usedInDelivery: true,
      ...(bot ? { botId: bot.id, botName: bot.name } : {}),
    };
  };
  // A demo publication: the digest is a placeholder, since the demo reads no workspace.
  const add = (path: string, ref: FileReference, bot: boolean) => {
    if (!bot) return addRef(path, ref, false, "input");
    addRef(path, ref, true, "verified", {
      id: `fpub_demo_${path.length}`,
      taskId: "task_demo",
      taskTitle: "Demo delivery",
      taskDeleted: false,
      deliveryKind: "complete",
      ...(ref.botId ? { botId: ref.botId } : {}),
      ...(ref.botName ? { botName: ref.botName } : {}),
      label: path.slice(path.lastIndexOf("/") + 1),
      sizeBytes: 1024,
      sha256: "0".repeat(64),
      check: "file-read-digest-v1",
      checkedAt: ref.at,
      publishedAt: ref.at,
      supersededCount: 0,
    });
  };
  add("/work/screenshots/dashboard-2026-10-09.png", said("researcher", 42), true);
  add(
    "/work/site/ops-status-report-for-the-quarterly-operations-review-with-appendices.html",
    said("chief", 55),
    true,
  );
  add("/work/q3/report.md", said("chief", 70), true);
  add("/work/q4/report.md", said("researcher", 75), true);
  add("/home/qa/checks/regression-run.log", said("qa", 90), true);
  add("/work/data/tickets-export.parquet", said("researcher", 130), true);
  // ADR-0014 amendment A6: a bounded CSV table with quoted cells and a config file as text.
  if (!s.files.has("/work/data/tickets-by-region.csv"))
    s.files.set(
      "/work/data/tickets-by-region.csv",
      'region,open,closed,note\nEMEA,42,310,"Includes ""priority"" queue"\nAPAC,17,198,"Tokyo, Singapore"\nAMER,29,402,\n',
    );
  add("/work/data/tickets-by-region.csv", said("researcher", 135), true);
  if (!s.files.has("/work/site/deploy.yaml"))
    s.files.set("/work/site/deploy.yaml", "service: ops-console\nreplicas: 2\nregion: emea\n");
  add("/work/site/deploy.yaml", said("chief", 140), true);
  add(
    "/work/inbox/vendor-brief.pdf",
    {
      kind: "message_attachment",
      at: minutesAgo(200),
      ...(thread ? { threadId: thread.id, threadTitle: thread.title } : {}),
      authorKind: "human",
      label: "Vendor brief",
    },
    false,
  );
}

/**
 * Demo switch for the Files screen's states, set in the browser console or by a screenshot
 * script: `localStorage.setItem("deskmates.demo.files", "empty" | "error" | "loading" | "stopped"
 * | "truncated")`. Absent means the normal collection.
 */
function demoFilesState(): string | undefined {
  try {
    return globalThis.localStorage?.getItem("deskmates.demo.files") ?? undefined;
  } catch {
    return undefined;
  }
}
