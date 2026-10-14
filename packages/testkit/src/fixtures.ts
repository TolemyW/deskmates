// Typed loaders for `fixtures/*.json` (test strategy §3.5). Each loader parses a fresh copy, so a
// test may mutate what it gets back. Paths resolve relative to this file, which works both from
// `src/` under vitest or tsx and from `dist/` after a build.

import { readFileSync } from "node:fs";
import type { BotDefinition, ModelPrice, RunEvent, Workspace } from "@deskmates/contracts";

const FIXTURES_DIR = new URL("../fixtures/", import.meta.url);

export type FixtureName = "workspace" | "bot" | "price-table" | "run-events";

/** Read and parse a fixture. The caller names the type; the JSON is the source of truth. */
export function loadFixture<T>(name: FixtureName): T {
  const text = readFileSync(new URL(`${name}.json`, FIXTURES_DIR), "utf8");
  return JSON.parse(text) as T;
}

export function loadWorkspaceFixture(): Workspace {
  return loadFixture<Workspace>("workspace");
}

export function loadBotFixture(): BotDefinition {
  return loadFixture<BotDefinition>("bot");
}

export function loadPriceTableFixture(): ModelPrice[] {
  return loadFixture<ModelPrice[]>("price-table");
}

/** One complete run: log, thinking, L0 navigate, screenshot, deferred L2 click, approval, finish. */
export function loadRunEventsFixture(): RunEvent[] {
  return loadFixture<RunEvent[]>("run-events");
}
