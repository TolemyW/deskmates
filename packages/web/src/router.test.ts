// T0: the hash router's routes, their href builders and the redirects that keep old links working.

import { describe, expect, it } from "vitest";
import {
  approvalsHref,
  computerHref,
  filesHref,
  knowledgeHref,
  legacyRedirect,
  newContactHref,
  parseRoute,
  runHref,
  skillsHref,
  taskHref,
  threadHref,
} from "./router.js";

describe("parseRoute", () => {
  it("parses threads, runs and approvals, and gives an unknown address a 404 route", () => {
    expect(parseRoute("#/threads")).toEqual({ name: "threads" });
    expect(parseRoute("#/threads/thr_1")).toEqual({ name: "threads", id: "thr_1" });
    expect(parseRoute("#/tasks")).toEqual({ name: "tasks" });
    expect(parseRoute("#/tasks/task_1")).toEqual({ name: "tasks", id: "task_1" });
    expect(parseRoute("#/tasks/a%2Fb")).toEqual({ name: "tasks", id: "a/b" });
    expect(parseRoute("#/runs/run_1")).toEqual({ name: "runs", id: "run_1" });
    expect(parseRoute("#/approvals")).toEqual({ name: "approvals" });
    expect(parseRoute("#/approvals/")).toEqual({ name: "approvals" });
    expect(parseRoute("#/integrations")).toEqual({ name: "connections", tab: "apps" });
    expect(parseRoute("#/resources/files")).toEqual({ name: "files" });
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/nope")).toEqual({ name: "notFound", path: "nope" });
  });

  it("parses the Resources destinations and Computer (issue #27)", () => {
    expect(parseRoute("#/knowledge")).toEqual({ name: "knowledge", tab: "documents" });
    expect(parseRoute("#/knowledge/documents")).toEqual({ name: "knowledge", tab: "documents" });
    expect(parseRoute("#/knowledge/observations")).toEqual({
      name: "knowledge",
      tab: "observations",
    });
    expect(parseRoute("#/knowledge/nope")).toEqual({ name: "knowledge", tab: "documents" });
    expect(parseRoute("#/skills")).toEqual({ name: "skills" });
    expect(parseRoute("#/computer")).toEqual({ name: "computer" });
  });

  it("builds hrefs with encoded ids", () => {
    expect(threadHref("a/b")).toBe("#/threads/a%2Fb");
    expect(runHref("a/b")).toBe("#/runs/a%2Fb");
    expect(taskHref()).toBe("#/tasks");
    expect(taskHref("a/b")).toBe("#/tasks/a%2Fb");
    expect(approvalsHref()).toBe("#/approvals");
    expect(filesHref()).toBe("#/resources/files");
    expect(parseRoute(filesHref())).toEqual({ name: "files" });
    expect(knowledgeHref()).toBe("#/knowledge/documents");
    expect(knowledgeHref("observations")).toBe("#/knowledge/observations");
    expect(skillsHref()).toBe("#/skills");
    expect(computerHref()).toBe("#/computer");
    expect(newContactHref()).toBe("#/contacts/new");
    expect(parseRoute(newContactHref())).toEqual({ name: "contacts", creating: true });
  });
});

describe("old links keep their meaning", () => {
  // Old address -> where its content lives now. `/workspace` alone meant the Library tab.
  const table: Array<[string, string, ReturnType<typeof parseRoute>]> = [
    ["#/workspace", "#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/workspace/library", "#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/workspace/unknown", "#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/workspace/facts", "#/knowledge/observations", { name: "knowledge", tab: "observations" }],
    ["#/workspace/settings", "#/computer", { name: "computer" }],
    ["#/knowledge", "#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/memory", "#/knowledge/observations", { name: "knowledge", tab: "observations" }],
    ["#/manage", "#/computer", { name: "computer" }],
  ];
  for (const [old, next, route] of table) {
    it(`${old} opens ${next}`, () => {
      expect(parseRoute(old)).toEqual(route);
      expect(legacyRedirect(old)).toBe(next);
    });
  }

  it("leaves current addresses alone", () => {
    for (const hash of [
      "#/knowledge/documents",
      "#/knowledge/observations",
      "#/skills",
      "#/computer",
      "#/threads/thr_1",
      "#/contacts",
      "",
    ])
      expect(legacyRedirect(hash)).toBeUndefined();
  });
});
