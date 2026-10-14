// Demo routes and seed of the Skills page (ADR-0015): a small fixture set with a held version and
// history. Changes are recorded in memory without the Gateway's scan or hash checks.

import type { BotId, Skill, SkillVersion, WorkspaceId } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, minutesAgo } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("skills", () => ({
    skills: [] as Skill[],
    skillVersions: new Map<string, SkillVersion[]>(),
  }));

export const demo: DemoFeature = {
  route,
  seed: {
    after: "team",
    run: (s, { ws, chief, qa, now }) => seedSkills(s, ws.id, chief.id, qa.id, now),
  },
};

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  // Skills (ADR-0015): a small fixture set so the Skills page shows rows, a held version
  // and history. Changes are recorded in memory without the Gateway's scan or hash checks.
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/skills$/))) {
    const workspaceId = decodeURIComponent(x[1] ?? "") as WorkspaceId;
    if (method === "POST") return installDemoSkill(s, workspaceId, b);
    return ok(skillsView(s, workspaceId, req.query));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/skills\/pending$/))) {
    const pending = pendingOf(s, decodeURIComponent(x[1] ?? "") as WorkspaceId);
    const limit = Number(req.query.get("limit") ?? 25) || 25;
    const start = Number(req.query.get("cursor") ?? 0) || 0;
    return ok({
      pending: pending.slice(start, start + limit),
      total: pending.length,
      ...(start + limit < pending.length ? { nextCursor: String(start + limit) } : {}),
    });
  }
  const skillRoute = m(
    /^\/api\/skills\/([^/]+)(?:\/(versions|assign|undo))?(?:\/(\d+)\/(confirm|reject))?$/,
  );
  if (skillRoute) return demoSkillRoute(s, skillRoute, method, b);
  return undefined;
}

/** One page of the workspace's skills by name, searched like the Gateway (#113). */
function skillsView(s: DemoState, workspaceId: WorkspaceId, q: URLSearchParams) {
  const needle = (q.get("q") ?? "").toLowerCase();
  const limit = Number(q.get("limit") ?? 25) || 25;
  const offset = Number(q.get("offset") ?? 0) || 0;
  const skills = store(s)
    .skills.filter((skill) => skill.workspaceId === workspaceId)
    .filter(
      (skill) =>
        !needle ||
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    starterPack: { version: "", sha256: "" },
    starterSkills: [],
    skills: skills.slice(offset, offset + limit),
    offset,
    limit,
    total: skills.length,
    pendingTotal: pendingOf(s, workspaceId).length,
  };
}

function pendingOf(s: DemoState, workspaceId: WorkspaceId) {
  return store(s)
    .skills.filter((skill) => skill.workspaceId === workspaceId)
    .flatMap((skill) =>
      (store(s).skillVersions.get(skill.id) ?? [])
        .filter((version) => version.review === "pending")
        .map((version) => ({ ...version, name: skill.name })),
    );
}

function demoSkillRoute(
  s: DemoState,
  x: RegExpMatchArray,
  method: string,
  b: Record<string, unknown>,
): Result {
  const skill = store(s).skills.find((item) => item.id === decodeURIComponent(x[1] ?? ""));
  if (!skill) return notFound("skill");
  const versions = store(s).skillVersions.get(skill.id) ?? [];
  const now = new Date().toISOString();
  if (x[2] === "versions" && x[4]) {
    const version = versions.find((item) => item.version === Number(x[3]));
    if (!version) return notFound("skill version");
    version.review = x[4] === "confirm" ? "cleared" : "rejected";
    version.decidedBy = "human:operator";
    version.decidedAt = now;
    if (version.review === "cleared") {
      skill.version = version.version;
      skill.sha256 = version.sha256;
      skill.description = version.description;
    }
    skill.pendingVersions = versions.filter((item) => item.review === "pending").length;
    return ok({ skill });
  }
  // Newest first; the demo histories are short enough to fit one page.
  if (x[2] === "versions") return ok({ versions: [...versions].reverse() });
  if (x[2] === "assign") {
    const ids = Array.isArray(b.botIds) ? (b.botIds as BotId[]) : [];
    skill.assignments = ids.map((botId) => ({
      botId,
      basis: "human" as const,
      by: "human:operator",
      createdAt: now,
    }));
    return ok({ skill });
  }
  if (x[2] === "undo") {
    const previous = versions
      .filter((item) => item.review === "cleared" && item.version < skill.version)
      .at(-1);
    if (previous) {
      skill.version = previous.version;
      skill.sha256 = previous.sha256;
    }
    return ok({ skill });
  }
  if (method === "PATCH") {
    if (typeof b.stage === "string") skill.stage = b.stage as Skill["stage"];
    if (typeof b.pinned === "boolean") skill.pinned = b.pinned;
    skill.updatedAt = now;
  }
  return ok({ skill });
}

function installDemoSkill(
  s: DemoState,
  workspaceId: WorkspaceId,
  b: Record<string, unknown>,
): Result {
  const files = Array.isArray(b.files) ? (b.files as SkillVersion["files"]) : [];
  const md = files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const name = /^name:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? "new-skill";
  const description = /^description:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? "";
  const now = new Date().toISOString();
  const botIds = Array.isArray(b.botIds) ? (b.botIds as BotId[]) : [];
  const sha256 = String(b.sha256 ?? "");
  const skill: Skill = {
    id: id("skill"),
    workspaceId,
    name,
    description,
    origin: "installed",
    stage: "active",
    assignments: botIds.map((botId) => ({
      botId,
      basis: "human",
      by: "human:operator",
      createdAt: now,
    })),
    version: 1,
    sha256,
    pinned: false,
    ...(typeof b.provenance === "string" ? { provenance: b.provenance } : {}),
    listedSince: now,
    pendingVersions: 0,
    createdAt: now,
    updatedAt: now,
  };
  const version: SkillVersion = {
    skillId: skill.id,
    version: 1,
    op: "install",
    files,
    sha256,
    description,
    review: "cleared",
    holdReasons: [],
    findings: [],
    derivedFrom: [],
    by: "human:operator",
    createdAt: now,
  };
  store(s).skills.push(skill);
  store(s).skillVersions.set(skill.id, [version]);
  return { status: 201, json: { skill, version } };
}

function seedSkills(
  s: DemoState,
  workspaceId: WorkspaceId,
  chief: BotId,
  qa: BotId,
  now: number,
): void {
  const file = (name: string, description: string, body: string) => [
    {
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    },
  ];
  const add = (
    skill: Omit<Skill, "workspaceId" | "createdAt" | "updatedAt" | "pendingVersions">,
    versions: Omit<SkillVersion, "skillId">[],
  ) => {
    store(s).skills.push({
      ...skill,
      workspaceId,
      pendingVersions: versions.filter((item) => item.review === "pending").length,
      createdAt: skill.listedSince,
      updatedAt: skill.listedSince,
    });
    store(s).skillVersions.set(
      skill.id,
      versions.map((version) => ({ ...version, skillId: skill.id })),
    );
  };
  const cleared = { review: "cleared" as const, holdReasons: [], findings: [], derivedFrom: [] };
  const weekly = "Assemble the weekly operations brief from the KPI notes in /work.";
  add(
    {
      id: "skill_weekly_brief",
      name: "weekly-ops-brief",
      description: weekly,
      origin: "installed",
      stage: "active",
      assignments: [
        {
          botId: chief,
          basis: "human",
          by: "human:operator",
          createdAt: minutesAgo(60 * 50, now),
        },
      ],
      version: 2,
      sha256: "4f7c1d2e9a0b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5",
      pinned: true,
      provenance: "Internal runbook, reviewed by the ops lead",
      lastUsedAt: minutesAgo(60 * 3, now),
      listedSince: minutesAgo(60 * 24 * 6, now),
    },
    [
      {
        ...cleared,
        version: 1,
        op: "install",
        files: file("weekly-ops-brief", weekly, "1. Read /work/notes.md."),
        sha256: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
        description: weekly,
        by: "human:operator",
        createdAt: minutesAgo(60 * 24 * 6, now),
      },
      {
        ...cleared,
        version: 2,
        op: "install",
        files: file("weekly-ops-brief", weekly, "1. Read /work/notes.md.\n2. Cite each figure."),
        sha256: "4f7c1d2e9a0b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5",
        description: weekly,
        by: "human:operator",
        createdAt: minutesAgo(60 * 50, now),
      },
    ],
  );
  const exportName = "export-ticket-list-before-counting-regressions-by-component";
  const exportText =
    "Export the filtered ticket list as CSV before counting open regressions by component and owner.";
  add(
    {
      id: "skill_ticket_export",
      name: exportName,
      description: exportText,
      origin: "authored",
      stage: "provisional",
      authorBotId: qa,
      assignments: [],
      version: 1,
      sha256: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
      pinned: false,
      listedSince: minutesAgo(60 * 26, now),
    },
    [
      {
        ...cleared,
        version: 1,
        op: "author",
        files: file(exportName, exportText, "1. Export the CSV.\n2. Count by component."),
        sha256: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
        description: exportText,
        derivedFrom: ["episode_seed"],
        by: `bot:${qa}`,
        createdAt: minutesAgo(60 * 26, now),
      },
    ],
  );
  const rates = "Fetch the exchange rates the KPI dashboard uses.";
  add(
    {
      id: "skill_fetch_rates",
      name: "fetch-rates",
      description: "",
      origin: "installed",
      stage: "active",
      assignments: [],
      version: 0,
      pinned: false,
      provenance: "Shared by a partner team",
      listedSince: minutesAgo(30, now),
    },
    [
      {
        version: 1,
        op: "install",
        files: [
          ...file("fetch-rates", rates, "Run fetch.sh, then read rates.elsewhere.example."),
          {
            path: "fetch.sh",
            content: "#!/bin/sh\ncurl https://rates.elsewhere.example/today\n",
          },
        ],
        sha256: "cd34ab12ef56cd34ab12ef56cd34ab12ef56cd34ab12ef56cd34ab12ef56cd34",
        description: rates,
        review: "pending",
        holdReasons: ["scan_findings"],
        findings: [
          { kind: "executable_file", path: "fetch.sh", detail: "script file extension" },
          {
            kind: "off_allowlist_url",
            path: "SKILL.md",
            line: 6,
            detail: "rates.elsewhere.example",
          },
        ],
        derivedFrom: [],
        by: "human:operator",
        createdAt: minutesAgo(30, now),
      },
    ],
  );
}
