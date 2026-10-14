// Demo routes and seed of the Knowledge page and learned memory: the approved library with its
// proposals, memory entries with versions (forget, undo, confirm, edit), and suggestions that
// wait for review. Learned memory itself is shared state, because scripted runs and chats add to
// it.

import {
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeProposal,
  MEMORY_BATCH_MAX,
  type MemoryConfirmation,
  type MemoryReviewBatch,
  type RunId,
  type WorkspaceId,
  memoryReviewGroupKey,
  memoryTopic,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest, DemoSeedContext } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, minutesAgo } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("knowledge", () => ({
    documents: [] as KnowledgeDocument[],
    proposals: [] as KnowledgeProposal[],
    confirmations: [] as MemoryConfirmation[],
    batches: [] as MemoryReviewBatch[],
  }));

/** ADR-0011 amendment 3 (A17): the demo's pending items of one workspace by review group. */
function pendingGroups(s: DemoState, workspaceId: string) {
  const groups = new Map<string, MemoryConfirmation[]>();
  for (const item of store(s).confirmations) {
    if (item.status !== "pending" || item.workspaceId !== workspaceId) continue;
    const key = memoryReviewGroupKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

export const demo: DemoFeature = { route, seed: { after: "team", run: seed } };

/**
 * The Gateway's page answer (#113): a search pages by offset, a list by an opaque cursor (here
 * the next row's index); both report the whole list's total.
 */
function demoPage<K extends string, T>(
  key: K,
  rows: T[],
  q: URLSearchParams,
  byOffset: boolean,
): Record<K, T[]> & { total: number; nextCursor?: string; offset?: number; limit?: number } {
  const limit = Number(q.get("limit") ?? 25) || 25;
  const offset = Number((byOffset ? q.get("offset") : q.get("cursor")) ?? 0) || 0;
  const next = offset + limit;
  return {
    [key]: rows.slice(offset, next),
    total: rows.length,
    ...(byOffset ? { offset, limit } : next < rows.length ? { nextCursor: String(next) } : {}),
  } as Record<K, T[]> & { total: number };
}

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/memory\/search$/))) {
    const text = (q.get("q") ?? "").toLocaleLowerCase();
    const scope = q.get("scope");
    return ok({
      entries: s.memory.filter(
        (e) =>
          !e.tombstoned &&
          e.body.toLocaleLowerCase().includes(text) &&
          (!scope || e.scope === scope),
      ),
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/memory$/))) {
    const scope = q.get("scope");
    const botId = q.get("botId");
    const threadId = q.get("threadId");
    const topic = q.get("topic")?.toLowerCase();
    const forgotten = q.get("includeForgotten") === "1";
    return ok(
      demoPage(
        "entries",
        s.memory.filter(
          (e) =>
            (forgotten || !e.tombstoned) &&
            (!scope || e.scope === scope) &&
            (!botId || e.botId === botId) &&
            (!threadId || e.threadId === threadId) &&
            (!topic || memoryTopic(e.body)?.key === topic),
        ),
        q,
        false,
      ),
    );
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/memory\/topics$/))) {
    const counts = new Map<string, { key: string; label: string; count: number }>();
    for (const e of s.memory) {
      const topic = e.tombstoned ? undefined : memoryTopic(e.body);
      if (!topic) continue;
      const seen = counts.get(topic.key) ?? { ...topic, count: 0 };
      counts.set(topic.key, { ...seen, count: seen.count + 1 });
    }
    const topics = [...counts.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    );
    return ok({ topics: topics.slice(0, 25), offset: 0, limit: 25, total: topics.length });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/memory-review\/(groups|preview|batches|undo)$/))) {
    const workspaceId = decodeURIComponent(x[1] ?? "") as WorkspaceId;
    const groups = pendingGroups(s, workspaceId);
    const batches = store(s).batches.filter((batch) => batch.workspaceId === workspaceId);
    if (x[2] === "groups")
      return ok({
        groups: [...groups].map(([groupKey, items]) => ({
          groupKey,
          workspaceId,
          proposedScope: items[0]?.proposedScope,
          trust: items[0]?.trust,
          count: items.length,
          items: items.slice(0, MEMORY_BATCH_MAX),
          oldestAt: items[0]?.createdAt,
          newestAt: items.at(-1)?.createdAt,
        })),
        totalGroups: groups.size,
        totalItems: [...groups.values()].reduce((sum, items) => sum + items.length, 0),
        batches: [...batches].reverse().slice(0, 5),
      });
    if (x[2] === "undo") {
      const batch = batches.find((b) => b.id === String(req.body.batchId) && !b.undoneAt);
      if (!batch) return notFound("review batch");
      for (const item of store(s).confirmations)
        if (batch.itemIds.includes(item.id)) item.status = "pending";
      batch.undoneAt = new Date().toISOString();
      batch.undoneBy = "operator";
      return ok({ batch });
    }
    const groupKey = String(req.body.groupKey);
    const items = (groups.get(groupKey) ?? []).slice(0, MEMORY_BATCH_MAX);
    if (items.length === 0) return notFound("review group");
    const decision = req.body.decision === "merge" ? "merge" : "reject";
    const token = `${groupKey}:${items.map((i) => i.id).join(",")}`;
    if (x[2] === "preview")
      return ok({
        preview: {
          groupKey,
          decision,
          itemIds: items.map((i) => i.id),
          ...(decision === "merge" ? { representativeId: items[0]?.id } : {}),
          remaining: (groups.get(groupKey)?.length ?? 0) - items.length,
          token,
        },
      });
    for (const item of items) item.status = decision === "merge" ? "applied" : "rejected";
    const batch: MemoryReviewBatch = {
      id: id("mrb"),
      workspaceId,
      groupKey,
      decision,
      itemIds: items.map((i) => i.id),
      createdEntry: false,
      decidedBy: "operator",
      createdAt: new Date().toISOString(),
    };
    if (decision === "merge" && items[0]) {
      const first = items[0];
      s.addMemory({
        scope: first.proposedScope,
        kind: "note",
        botId: first.botId,
        body: first.body,
        authority: first.authority,
        trust: "trusted",
        sourceKind: "human",
        sourceRunId: first.runId,
        derivedFrom: items.map((i) => i.id),
      });
    }
    store(s).batches.push(batch);
    return ok({ batch });
  }
  if (path === "/api/knowledge" && method === "GET") {
    const text = (q.get("q") ?? "").toLocaleLowerCase();
    const documents: KnowledgeHit[] = store(s)
      .documents.filter((d) => !text || `${d.title} ${d.body}`.toLocaleLowerCase().includes(text))
      .map((d) => ({
        id: d.id,
        title: d.title,
        excerpt: d.body.slice(0, 140),
        version: d.version,
      }));
    return ok(demoPage("documents", documents, q, Boolean(text)));
  }
  if (path === "/api/knowledge/proposals" && method === "GET") {
    const status = q.get("status") ?? "pending";
    return ok(
      demoPage(
        "proposals",
        store(s).proposals.filter((p) => p.status === status),
        q,
        false,
      ),
    );
  }
  if (path === "/api/knowledge/proposals" && method === "POST") {
    const proposal: KnowledgeProposal = {
      id: id("prp"),
      title: String(b.title),
      body: String(b.body),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    store(s).proposals.push(proposal);
    return created({ proposal });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/knowledge\/proposals\/([^/]+)\/review$/))) {
    const proposal = store(s).proposals.find((p) => p.id === decodeURIComponent(x?.[1] ?? ""));
    if (!proposal) return notFound("proposal");
    proposal.status = b.decision === "approve" ? "approved" : "rejected";
    proposal.reviewedBy = "operator";
    proposal.reviewedAt = new Date().toISOString();
    if (proposal.status === "approved") {
      const document: KnowledgeDocument = {
        id: id("doc"),
        title: proposal.title,
        body: proposal.body,
        version: 1,
        approvedBy: "operator",
        updatedAt: proposal.reviewedAt,
      };
      store(s).documents.push(document);
      proposal.documentId = document.id;
    }
    return ok({ proposal });
  }
  if (path === "/api/knowledge/versions/cleanup")
    return ok({ removed: 0, retained: store(s).documents.length });
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/knowledge\/([^/]+)\/history$/))) {
    const document = store(s).documents.find((d) => d.id === decodeURIComponent(x?.[1] ?? ""));
    if (!document) return notFound("document");
    return ok({
      versions: [
        {
          documentId: document.id,
          version: document.version,
          title: document.title,
          body: document.body,
          approvedBy: document.approvedBy,
          createdAt: document.updatedAt,
        },
      ],
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/knowledge\/([^/]+)$/))) {
    const document = store(s).documents.find((d) => d.id === decodeURIComponent(x?.[1] ?? ""));
    if (!document) return notFound("document");
    if (method === "PATCH") {
      document.title = typeof b.title === "string" ? b.title : document.title;
      document.body = typeof b.body === "string" ? b.body : document.body;
      document.version += 1;
      document.updatedAt = new Date().toISOString();
    }
    return ok({ document });
  }

  if (path === "/api/memory-suggestions" && method === "GET") {
    const status = q.get("status") ?? "pending";
    const suggestions = store(s).confirmations.filter((c) => c.status === status);
    return ok({ suggestions, total: suggestions.length });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/memory-suggestions\/([^/]+)\/review$/))) {
    const item = store(s).confirmations.find((c) => c.id === decodeURIComponent(x?.[1] ?? ""));
    if (!item) return notFound("suggestion");
    item.status = b.decision === "apply" ? "applied" : "rejected";
    item.reviewedBy = "operator";
    item.reviewedAt = new Date().toISOString();
    if (item.status === "applied") {
      s.addMemory({
        scope: item.proposedScope,
        kind: "note",
        botId: item.botId,
        body: item.body,
        authority: item.authority,
        trust: "trusted",
        sourceKind: "human",
        sourceRunId: item.runId,
        derivedFrom: [item.id],
      });
    }
    return ok({ suggestion: item });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/memory\/entries\/([^/]+)\/provenance$/))) {
    const entry = s.memory.find((e) => e.id === decodeURIComponent(x?.[1] ?? ""));
    if (!entry) return notFound("memory entry");
    // The demo keeps one source per entry and no replacements (ADR-0011 amendment 2).
    return ok({
      sources: [
        {
          entryId: entry.id,
          ...(entry.sourceRunId ? { sourceRunId: entry.sourceRunId } : {}),
          sourceKind: entry.sourceKind,
          trust: entry.trust,
          effectiveAt: entry.observedAt,
          effectiveBasis: "run",
          recordedAt: entry.observedAt,
        },
      ],
      supersessions: [],
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/memory\/entries\/([^/]+)\/versions$/))) {
    // Newest first, like the Gateway (#113 K2); the demo has no second page.
    return ok({ versions: [...(s.versions.get(decodeURIComponent(x[1] ?? "")) ?? [])].reverse() });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/memory\/entries\/([^/]+)(?:\/(forget|undo|confirm))?$/))) {
    const entry = s.memory.find((e) => e.id === decodeURIComponent(x?.[1] ?? ""));
    if (!entry) return notFound("memory entry");
    const op = x[2];
    const history = s.versions.get(entry.id) ?? [];
    if (op === "forget") {
      entry.tombstoned = true;
      entry.live = false;
      for (const v of history) v.redacted = true;
      s.pushVersion(entry, "forget");
    } else if (op === "undo") {
      const previous = history.filter((v) => v.op !== "forget").at(-2);
      if (previous) entry.body = previous.body;
      s.pushVersion(entry, "undo");
    } else if (op === "confirm") {
      entry.trust = "trusted";
      entry.lastConfirmedAt = new Date().toISOString();
      s.pushVersion(entry, "confirm");
    } else if (method === "PATCH") {
      if (typeof b.expectedVersion === "number" && b.expectedVersion !== entry.version) {
        return {
          status: 409,
          json: { code: "conflict", message: "entry changed since it was loaded", details: {} },
        };
      }
      entry.body = String(b.body ?? entry.body);
      s.pushVersion(entry, "edit");
    }
    return ok({ entry });
  }
  return undefined;
}

/** Two library documents, a pending proposal, three learned entries and a gated suggestion. */
function seed(s: DemoState, { now, ws, researcher, qa }: DemoSeedContext): void {
  // Knowledge library.
  store(s).documents.push(
    {
      id: id("doc"),
      title: "Galaxy Ops console: where things are",
      body: "# Galaxy Ops console\n\n- /dashboard: weekly KPI table (revenue, active fleets, churn)\n- /tickets: ticket list; filter by priority and status\n- Export CSV on /tickets downloads the current filter\n",
      version: 2,
      approvedBy: "operator",
      updatedAt: minutesAgo(60 * 24 * 2, now),
    },
    {
      id: id("doc"),
      title: "Weekly brief format",
      body: "# Weekly brief\n\nOne page. Sections: KPIs, Open tickets, Risks. Every number names the file it came from.\n",
      version: 1,
      approvedBy: "operator",
      updatedAt: minutesAgo(60 * 24 * 5, now),
    },
  );
  store(s).proposals.push({
    id: id("prp"),
    title: "Ticket ageing rule of thumb",
    body: "A P1 older than 7 days should be called out in the brief's Risks section.",
    status: "pending",
    createdAt: minutesAgo(50, now),
  });

  // Workspace facts, bot experience and a gated item.
  s.addMemory({
    scope: "workspace",
    kind: "note",
    body: "The ticket list on /tickets paginates at 50 rows; the export covers the whole filter.",
    authority: "fact",
    trust: "trusted",
    sourceKind: "tool",
    derivedFrom: [],
    learnedBy: "qa",
    observedAt: minutesAgo(60 * 26, now),
  });
  s.addMemory({
    scope: "bot",
    kind: "note",
    botId: researcher.id,
    body: "Reading the dashboard right after 07:00 UTC catches the nightly refresh; earlier reads show yesterday's numbers.",
    authority: "procedure",
    trust: "trusted",
    sourceKind: "bot_self",
    derivedFrom: [],
    learnedBy: "researcher",
    observedAt: minutesAgo(60 * 30, now),
  });
  s.addMemory({
    scope: "workspace",
    kind: "note",
    body: "ops.example.test logs you out after 12 hours; a human has to sign in again from the desktop.",
    authority: "fact",
    trust: "untrusted",
    sourceKind: "tool",
    derivedFrom: [],
    learnedBy: "researcher",
    observedAt: minutesAgo(60 * 5, now),
  });
  store(s).confirmations.push({
    id: id("sug"),
    workspaceId: ws.id,
    runId: "run_seed" as RunId,
    botId: qa.id,
    body: "Always export the ticket list before counting, the on-screen count lags the filter.",
    proposedScope: "bot",
    authority: "procedure",
    trust: "trusted",
    reasons: ["imperative"],
    conflictsWith: [],
    status: "pending",
    createdAt: minutesAgo(40, now),
  });
}
