// Id and timestamp helpers shared by the query modules.

import { randomUUID } from "node:crypto";
import type { IsoTimestamp } from "@deskmates/contracts";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  return JSON.parse(text) as T;
}
