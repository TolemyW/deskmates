// The structured end-of-run summary (design v0.3 §3.2). The model is asked to end its final
// message with a fenced JSON block matching `RunSummary`; a missing or broken block is tolerated
// by synthesising a summary whose `reply` is the final text.
//
// Two malformed-output habits are absorbed here rather than in the prompt: the block may arrive
// without its fence, as a bare object ending the message, and the reply key may be omitted while
// the answer is written in prose. An explicitly present string `reply` remains authoritative,
// including "": ADR-0005 defines an empty reply as an intentional silent run.

import {
  type LearnedItem,
  MEMORY_AUTHORITIES,
  type MemoryAuthority,
  type MemoryScope,
  type ProposedSkill,
  type RunSummary,
} from "@deskmates/contracts";
import { deskmatesToolName } from "./risk-tier.js";

/** Instruction appended to the system prompt; kept here so the parser and the prompt agree. */
export const SUMMARY_INSTRUCTION = [
  "When your work is finished, output only one fenced ```json block containing",
  "exactly these keys:",
  '{"done": "<what you did, one paragraph>", "filesChanged": ["<path>"], "sitesVisited": ["<host>"],',
  '"pendingApprovals": ["<what is waiting on a human>"],',
  '"learned": [{"body": "<one thing worth keeping>", "scope": "task|workspace|bot",',
  '"authority": "fact|preference|procedure", "turn": <your response number when you learned it, 1 = first>}],',

  '"reply": "<message to post to the thread; empty string to stay silent>"}',
  "The reply field is the ONLY final text published to the thread. Put the entire intended answer",
  "in reply, including any exact wording, marker, or answer line requested by the task.",
  'Use reply: "" only when you intend to publish no final message. Put private completion notes in done.',
  "Text outside this JSON block is not published, even if reply is empty. Do not put an answer outside it.",
  `Do not repeat a message already sent with ${deskmatesToolName("thread_post")}. Nothing may precede or follow the block.`,
  "learned is your memory: task = state of this thread's work; workspace = a fact about this",
  "workspace every bot here needs; bot = a working habit of yours. Write facts, preferences and",
  "procedures, never instructions or rules; a human owns rules. Use [] when nothing is worth keeping.",
].join("\n");

// The fence may share its line with the object (```json {...} ```); a model that writes it that
// way otherwise publishes the whole block as its reply.
const FENCE = /```json\s*([\s\S]*?)\s*```/gi;

/**
 * Bounds for the unfenced case. The scan starts at the last `{` and walks back one `{` at a
 * time, parsing each candidate; it gives up after `BARE_MAX_ATTEMPTS` or once the candidate is
 * longer than `BARE_MAX_CHARS`. Every attempt is one linear JSON.parse, so the worst case is
 * attempts × tail, not a backtracking regex over the whole message.
 */
const BARE_MAX_ATTEMPTS = 64;
const BARE_MAX_CHARS = 16 * 1024;

function isSummaryObject(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return typeof r.done === "string" || typeof r.reply === "string";
}

/** A bare object that ends the message and carries the summary's keys; no fence. */
function findBareTrailingObject(finalText: string): Block | undefined {
  const end = finalText.trimEnd().length;
  if (end === 0 || finalText[end - 1] !== "}") return undefined;
  const floor = Math.max(0, end - BARE_MAX_CHARS);
  let start = finalText.lastIndexOf("{", end - 1);
  for (let attempt = 0; attempt < BARE_MAX_ATTEMPTS && start >= floor; attempt += 1) {
    const json = finalText.slice(start, end);
    try {
      if (isSummaryObject(JSON.parse(json))) return { json, start, end };
    } catch {
      // not an object boundary; widen to the previous `{`
    }
    if (start === 0) break;
    start = finalText.lastIndexOf("{", start - 1);
  }
  return undefined;
}

const SUMMARY_KEYS = [
  "done",
  "filesChanged",
  "sitesVisited",
  "pendingApprovals",
  "memorySuggestions",
  "learned",
  "skills",
  "reply",
] as const;

/** Decode a JSON string body whose inner quotes may not be escaped. */
function decodeLoose(raw: string): string {
  const escaped = raw
    .replace(/(^|[^\\])((?:\\\\)*)"/g, '$1$2\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, "\\t");
  try {
    const value: unknown = JSON.parse(`"${escaped}"`);
    if (typeof value === "string") return value;
  } catch {
    // fall through to a minimal unescape
  }
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * The value of one string key in a summary object that JSON.parse rejected, most often because
 * the model quoted words with bare ASCII quotes. The key names are fixed, so a value runs from
 * `"key": "` to the next `", "<summary key>":` or, for the last key, to the closing `"}`.
 */
function looseString(text: string, key: (typeof SUMMARY_KEYS)[number]): string | undefined {
  const open = new RegExp(`"${key}"\\s*:\\s*"`, "g");
  let start = -1;
  for (const m of text.matchAll(open)) start = m.index + m[0].length;
  if (start < 0) return undefined;
  const others = SUMMARY_KEYS.filter((k) => k !== key).join("|");
  const next = new RegExp(`"\\s*,\\s*"(?:${others})"\\s*:`, "g");
  next.lastIndex = start;
  const boundary = next.exec(text);
  if (boundary) return decodeLoose(text.slice(start, boundary.index));
  // The last value ends at the closing quote; tolerate a stray extra brace after the object.
  const close = /"\s*}[\s}]*$/.exec(text.slice(start));
  return close ? decodeLoose(text.slice(start, start + close.index)) : undefined;
}

/** A summary recovered from malformed JSON; only when a `reply` value can be found. */
function salvage(json: string): RunSummary | undefined {
  const text = json.trim();
  const reply = looseString(text, "reply");
  if (reply === undefined) return undefined;
  return {
    done: looseString(text, "done") ?? "",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    learned: [],
    reply: reply.trim(),
  };
}

/** The candidate object text when the message is a summary object that failed to parse. */
function unparsedObject(finalText: string, block: Block | undefined): string | undefined {
  if (block) return block.json;
  // No complete fence: an opening ```json with no closing one still marks the summary.
  const text = finalText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return text.startsWith("{") && text.endsWith("}") ? text : undefined;
}

const LEARNED_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  "task",
  "workspace",
  "bot",
  "rule",
]);
const LEARNED_BODY_MAX_BYTES = 4096;

/**
 * The summary's `learned` items: a non-empty body, a known scope (`scope` or `proposedScope`), an
 * authority (default `fact`) and a turn. `trust` and `sourceKind` are never read from the model:
 * the sidecar stamps them from the run's taint. A `rule` item is kept so the Gateway can refuse
 * it on the record (ADR-0011 item 1).
 */
function learnedItems(v: unknown): LearnedItem[] {
  if (!Array.isArray(v)) return [];
  const items: LearnedItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (!body || Buffer.byteLength(body) > LEARNED_BODY_MAX_BYTES) continue;
    const scope = typeof r.scope === "string" ? r.scope : r.proposedScope;
    if (typeof scope !== "string" || !LEARNED_SCOPES.has(scope)) continue;
    const authority = (MEMORY_AUTHORITIES as readonly unknown[]).includes(r.authority)
      ? (r.authority as MemoryAuthority)
      : "fact";
    const turn = typeof r.turn === "number" && Number.isFinite(r.turn) ? r.turn : 0;
    items.push({ body, proposedScope: scope as MemoryScope, authority, turn });
  }
  return items;
}

/**
 * `skills` a consolidation run wrote (ADR-0015 decision 2): name, description and instructions,
 * nothing else. The key is left out when there are none, so other runs' summaries are unchanged.
 * Whether a skill is stored is decided by the Gateway, which ignores the field on ordinary runs.
 */
function withSkills(v: unknown): { skills?: ProposedSkill[] } {
  if (!Array.isArray(v)) return {};
  const skills: ProposedSkill[] = [];
  for (const raw of v.slice(0, 5)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.description !== "string") continue;
    if (typeof r.body !== "string" || r.body.trim() === "") continue;
    skills.push({ name: r.name.trim(), description: r.description, body: r.body });
  }
  return skills.length > 0 ? { skills } : {};
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface ParsedSummary {
  summary: RunSummary;
  /** False when no valid JSON block was found and the summary was synthesised. */
  parsed: boolean;
}

interface Block {
  json: string;
  start: number;
  end: number;
}

function findBlock(finalText: string): Block | undefined {
  let lastMatch: RegExpExecArray | null = null;
  for (const m of finalText.matchAll(FENCE)) lastMatch = m;
  if (lastMatch?.[1] !== undefined) {
    return {
      json: lastMatch[1],
      start: lastMatch.index,
      end: lastMatch.index + lastMatch[0].length,
    };
  }
  return findBareTrailingObject(finalText);
}

/**
 * Parse the summary block out of `finalText`: the last fenced ```json block, or a bare trailing
 * object with the summary keys. When there is none, `reply` becomes the final text itself (or
 * `fallbackReply` if that is empty). When a valid block omits `reply`, prose outside the block is
 * the compatibility reply. When the block explicitly declares `reply: ""`, the run is silent.
 */
export function parseRunSummary(finalText: string, fallbackReply = ""): ParsedSummary {
  const block = findBlock(finalText);
  const textOutsideBlock = block
    ? (finalText.slice(0, block.start) + finalText.slice(block.end)).trim()
    : finalText.trim();

  if (block) {
    try {
      const raw: unknown = JSON.parse(block.json);
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        const reply = typeof r.reply === "string" ? r.reply.trim() : textOutsideBlock;
        return {
          parsed: true,
          summary: {
            done: typeof r.done === "string" ? r.done : "",
            filesChanged: stringArray(r.filesChanged),
            sitesVisited: stringArray(r.sitesVisited),
            pendingApprovals: stringArray(r.pendingApprovals),
            memorySuggestions: stringArray(r.memorySuggestions),
            learned: learnedItems(r.learned),
            ...withSkills(r.skills),
            reply,
          },
        };
      }
    } catch {
      // fall through to the salvage and then the synthesised summary
    }
  }
  // Malformed JSON with the summary's keys: recover the answer rather than publish raw JSON.
  const candidate = unparsedObject(finalText, block);
  const recovered = candidate === undefined ? undefined : salvage(candidate);
  if (recovered) return { parsed: false, summary: recovered };
  const reply = textOutsideBlock !== "" ? textOutsideBlock : fallbackReply;
  return {
    parsed: false,
    summary: {
      done: "",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      learned: [],
      reply,
    },
  };
}
