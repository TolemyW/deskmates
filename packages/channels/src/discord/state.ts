// A Discord connection's private state, one JSON file in the connection's state directory (0700,
// the file 0600, ADR-0047 decision 14): the Gateway session to resume, the relay cursor and
// delivered-chunk progress of each thread, and the last message seen in each DM channel so a
// restart that cannot resume can read what it missed. It holds no token. The Gateway deletes the
// directory on disconnect.
//
// What belongs to one credential (the Gateway session, partial chunk progress) is dropped when
// `credentialGeneration` changes (a relink). The per-DM last-seen ids, the bot user id and the
// thread cursors belong to the bot identity, which a relink keeps, so they survive it (ADR-0047
// decision 8); the Gateway's receipts answer `already_sent` for anything sent before.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscordResumeState } from "./gateway-session.js";

export const DISCORD_STATE_FILE = "discord-state.json";

export interface DiscordThreadCursor {
  /** Highest message seq relayed or skipped for good. */
  seq: number;
  /** A message whose first chunks were delivered and whose send is not recorded yet. */
  pending?: { seq: number; chunkIds: string[]; failed?: true };
}

export interface DiscordConnectionState {
  version: 1;
  credentialGeneration: number;
  resume: DiscordResumeState | null;
  /** The bot user's id, from READY; identity-scoped, so it survives a relink. */
  botUserId: string | null;
  threads: Record<string, DiscordThreadCursor>;
  /** DM channel id -> the newest inbound message id handled. */
  conversations: Record<string, string>;
}

export function emptyDiscordState(credentialGeneration: number): DiscordConnectionState {
  return {
    version: 1,
    credentialGeneration,
    resume: null,
    botUserId: null,
    threads: {},
    conversations: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursor(cursor: unknown): DiscordThreadCursor | undefined {
  if (!isRecord(cursor) || typeof cursor.seq !== "number") return undefined;
  const pending = cursor.pending;
  if (isRecord(pending) && typeof pending.seq === "number" && Array.isArray(pending.chunkIds))
    return {
      seq: cursor.seq,
      pending: {
        seq: pending.seq,
        chunkIds: pending.chunkIds.filter((id): id is string => typeof id === "string"),
        ...(pending.failed === true ? { failed: true as const } : {}),
      },
    };
  return { seq: cursor.seq };
}

function parseState(raw: unknown): DiscordConnectionState | undefined {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.credentialGeneration !== "number")
    return undefined;
  const state = emptyDiscordState(raw.credentialGeneration);
  const resume = raw.resume;
  if (
    isRecord(resume) &&
    typeof resume.sessionId === "string" &&
    typeof resume.resumeUrl === "string" &&
    resume.resumeUrl.startsWith("wss://")
  )
    state.resume = {
      sessionId: resume.sessionId,
      resumeUrl: resume.resumeUrl,
      seq: typeof resume.seq === "number" ? resume.seq : null,
    };
  if (typeof raw.botUserId === "string") state.botUserId = raw.botUserId;
  if (isRecord(raw.threads))
    for (const [threadId, value] of Object.entries(raw.threads)) {
      const cursor = parseCursor(value);
      if (cursor) state.threads[threadId] = cursor;
    }
  if (isRecord(raw.conversations))
    for (const [channelId, messageId] of Object.entries(raw.conversations))
      if (typeof messageId === "string") state.conversations[channelId] = messageId;
  return state;
}

/** Load the state for `credentialGeneration`, dropping what an older credential owned. */
export async function loadDiscordState(
  directory: string,
  credentialGeneration: number,
): Promise<DiscordConnectionState> {
  let stored: DiscordConnectionState | undefined;
  try {
    stored = parseState(JSON.parse(await readFile(join(directory, DISCORD_STATE_FILE), "utf8")));
  } catch {
    stored = undefined;
  }
  if (!stored) return emptyDiscordState(credentialGeneration);
  if (stored.credentialGeneration === credentialGeneration) return stored;
  const fresh = emptyDiscordState(credentialGeneration);
  fresh.conversations = stored.conversations;
  fresh.botUserId = stored.botUserId;
  for (const [threadId, cursor] of Object.entries(stored.threads))
    fresh.threads[threadId] = { seq: cursor.seq };
  return fresh;
}

/** Write atomically: a temporary 0600 file renamed over the old one. */
export async function saveDiscordState(
  directory: string,
  state: DiscordConnectionState,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, DISCORD_STATE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
