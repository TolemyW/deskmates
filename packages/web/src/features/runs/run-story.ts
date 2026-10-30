// The run's story: what the bot did, in its own words and in plain verbs, derived from the ledger
// it already writes (no new event kinds). A `thinking` event opens a segment headed by the bot's
// thought; the tool calls, approvals, screenshots, model retries and other happenings that follow
// are the segment's steps until the next thought. Telemetry (`turn_usage`, compactions, memory
// bookkeeping, diagnostic logs) is not part of the story; it stays in the technical log. Pure, so
// the grouping and the verbs are tested without React.

import type { RunEvent } from "@deskmates/contracts";
import type { MessageKey } from "../../i18n/catalogs.js";
import { isDesktopDenial } from "./desktop-denials.js";
import { type LedgerRow, ledgerRows } from "./ledger-rows.js";
import { shortToolName } from "./run-activity.js";

/** How much of a command, path, URL or message a step shows. */
const OBJECT_MAX = 120;
/** How much of a thought the segment heading shows before "more". */
const THOUGHT_MAX = 160;

export interface StoryThought {
  seq: number;
  ts: string;
  /** The whole thought, shown on demand. */
  text: string;
  /** Its first sentence or line, bounded, as the segment's heading. */
  heading: string;
  /** Whether `heading` left anything out. */
  truncated: boolean;
}

export type StoryTone = "done" | "now" | "error" | "warn" | "info";

export interface StoryStep {
  seq: number;
  ts: string;
  /** The verb's message key (`runStory.verb.*`). */
  verb: MessageKey;
  /** Values the verb's message interpolates (a name, a count). */
  values?: Readonly<Record<string, string | number>>;
  /** The command, path, URL, name or message the verb acts on, bounded to one line. */
  object?: string;
  tone: StoryTone;
  /** A tool step: the tool's bare name and its timing. */
  tool?: { name: string; durationMs: number | undefined; open: boolean; isError: boolean };
  /** A screenshot taken by, or right after, this step. */
  screenshot?: Record<string, unknown>;
  /** Free text the step carries: the bot's own log line, a stall note, an approval reason. */
  text?: string;
}

export interface StorySegment {
  thought?: StoryThought;
  steps: StoryStep[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The first non-empty line of `text`, cut at `max` characters on a word boundary when it can. */
export function firstLine(text: string, max = OBJECT_MAX): { text: string; truncated: boolean } {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return { text: "", truncated: false };
  const whole = line.length <= max;
  const truncated = !whole || line !== text.trim();
  if (whole) return { text: line, truncated };
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return { text: `${space > max / 2 ? cut.slice(0, space) : cut}…`, truncated: true };
}

/** A thought's heading: its first sentence, else its first line, bounded. */
export function thoughtHeading(text: string): { text: string; truncated: boolean } {
  const line = firstLine(text, Number.POSITIVE_INFINITY);
  const sentence = line.text.match(/^.*?(?:[.!?](?=\s|$)|[。！？])/u)?.[0] ?? line.text;
  const bounded = firstLine(sentence, THOUGHT_MAX);
  return {
    text: bounded.text,
    truncated: bounded.truncated || sentence !== line.text || line.truncated,
  };
}

function first(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = str(input[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** A URL as a person reads it: no scheme, no trailing slash. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

interface ToolDescription {
  verb: MessageKey;
  object?: string | undefined;
}

/** The plain verb and object of a tool call, from its name and input (Claude SDK names, the
 * browser MCP's names under `mcp__browser__`, the sidecar's own under `mcp__deskmates__`). */
export function describeTool(toolName: string, input: Record<string, unknown>): ToolDescription {
  const name = shortToolName(toolName);
  const server = toolName.startsWith("mcp__") ? toolName.split("__")[1] : undefined;
  switch (name) {
    case "Bash":
      return { verb: "runStory.verb.ran", object: first(input, ["command"]) };
    case "Read":
      return { verb: "runStory.verb.read", object: first(input, ["file_path", "path"]) };
    case "Write":
      return { verb: "runStory.verb.wrote", object: first(input, ["file_path", "path"]) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        verb: "runStory.verb.edited",
        object: first(input, ["file_path", "notebook_path", "path"]),
      };
    case "Glob":
    case "Grep":
      return { verb: "runStory.verb.searchedFiles", object: first(input, ["pattern", "path"]) };
    case "LS":
      return { verb: "runStory.verb.listed", object: first(input, ["path"]) };
    case "WebFetch":
      return { verb: "runStory.verb.fetched", object: first(input, ["url"]) };
    case "WebSearch":
      return { verb: "runStory.verb.searchedWeb", object: first(input, ["query"]) };
    case "Skill":
      return { verb: "runStory.verb.usedSkill", object: first(input, ["skill", "name"]) };
    case "Task":
    case "Agent":
      return {
        verb: "runStory.verb.delegated",
        object: first(input, ["description", "prompt"]),
      };
    case "TodoWrite":
      return { verb: "runStory.verb.plannedWork" };
    default:
      break;
  }
  if (server === "browser" || name.startsWith("browser_")) return describeBrowserTool(name, input);
  if (server === "deskmates") return describeDeskmatesTool(name, input);
  return { verb: "runStory.verb.usedTool", object: name };
}

function describeBrowserTool(name: string, input: Record<string, unknown>): ToolDescription {
  const element = first(input, ["element", "ref", "selector"]);
  switch (name) {
    case "browser_navigate": {
      const url = first(input, ["url"]);
      return { verb: "runStory.verb.opened", object: url ? displayUrl(url) : undefined };
    }
    case "browser_navigate_back":
      return { verb: "runStory.verb.wentBack" };
    case "browser_click":
    case "browser_mouse_click_xy":
      return { verb: "runStory.verb.clicked", object: element };
    case "browser_type":
    case "browser_fill_form":
      // The typed text may be a password; the step names the field only.
      return { verb: "runStory.verb.typed", object: element };
    case "browser_select_option":
      return { verb: "runStory.verb.selected", object: element };
    case "browser_press_key":
      return { verb: "runStory.verb.pressed", object: first(input, ["key"]) };
    case "browser_hover":
      return { verb: "runStory.verb.hovered", object: element };
    case "browser_snapshot":
    case "browser_take_screenshot":
      return { verb: "runStory.verb.lookedAtPage" };
    case "browser_wait_for":
      return { verb: "runStory.verb.waited", object: first(input, ["text", "textGone"]) };
    case "browser_tabs":
      return { verb: "runStory.verb.switchedTab", object: first(input, ["action"]) };
    case "browser_file_upload":
      return { verb: "runStory.verb.uploadedFile" };
    case "browser_evaluate":
    case "browser_run_code_unsafe":
      return { verb: "runStory.verb.ranPageScript" };
    default:
      return { verb: "runStory.verb.usedBrowser", object: name.replace(/^browser_/, "") };
  }
}

function describeDeskmatesTool(name: string, input: Record<string, unknown>): ToolDescription {
  switch (name) {
    case "thread_post":
      return { verb: "runStory.verb.posted", object: first(input, ["body", "text", "message"]) };
    case "message_bot":
      return {
        verb: "runStory.verb.messaged",
        object: first(input, ["bot", "botName", "to", "botId"]),
      };
    case "approval_decide":
      return { verb: "runStory.verb.decidedApproval", object: first(input, ["decision"]) };
    case "memory_search":
      return { verb: "runStory.verb.searchedMemory", object: first(input, ["query"]) };
    case "knowledge_search":
      return { verb: "runStory.verb.searchedKnowledge", object: first(input, ["query"]) };
    case "knowledge_read":
      return { verb: "runStory.verb.readKnowledge", object: first(input, ["title", "id"]) };
    case "knowledge_propose":
      return { verb: "runStory.verb.proposedKnowledge", object: first(input, ["title"]) };
    case "image_describe":
      return { verb: "runStory.verb.describedImage" };
    case "audio_transcribe":
      return { verb: "runStory.verb.transcribedAudio" };
    case "task_checkpoint":
      return { verb: "runStory.verb.checkpointed", object: first(input, ["note", "summary"]) };
    case "task_deliver":
      return { verb: "runStory.verb.delivered", object: first(input, ["summary", "note"]) };
    case "app_publish":
      return { verb: "runStory.verb.publishedApp", object: first(input, ["name", "title"]) };
    case "tty_session":
      return { verb: "runStory.verb.usedTerminal" };
    case "browser_cli_workflow":
      return { verb: "runStory.verb.ranBrowserWorkflow" };
    default:
      if (name.startsWith("connector_"))
        return {
          verb: "runStory.verb.usedConnector",
          object: first(input, ["connector", "connectorId", "name"]),
        };
      if (name.startsWith("integration_"))
        return {
          verb: "runStory.verb.usedIntegration",
          object: first(input, ["app", "appId", "name", "query"]),
        };
      return { verb: "runStory.verb.usedTool", object: name };
  }
}

function inputOf(payload: Record<string, unknown>): Record<string, unknown> {
  const input = payload.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function obj(object: string | undefined): { object?: string } {
  return object === undefined ? {} : { object: firstLine(object).text };
}

function toolStep(row: Extract<LedgerRow, { kind: "tool" }>): StoryStep {
  const { call, result } = row;
  const name = str(call.payload.toolName) ?? "";
  const { verb, object } = describeTool(name, inputOf(call.payload));
  return {
    seq: call.seq,
    ts: call.ts,
    verb,
    ...obj(object),
    tone: row.isError ? "error" : result ? "done" : "now",
    tool: {
      name: shortToolName(name),
      durationMs: row.durationMs,
      open: result === undefined,
      isError: row.isError,
    },
  };
}

function approvalStep(event: RunEvent): StoryStep | undefined {
  const p = event.payload;
  const base = { seq: event.seq, ts: event.ts };
  const tool = str(p.toolName) ? shortToolName(str(p.toolName) ?? "") : "";
  const who = str(p.decidedBy) ?? "";
  const reason = str(p.reason);
  switch (p.phase) {
    case "posted":
      return {
        ...base,
        verb: "runStory.verb.askedApproval",
        values: { tool },
        ...obj(str(p.argumentSummary)),
        tone: "warn",
      };
    case "decided":
      return {
        ...base,
        verb:
          p.decision === "deny" ? "runStory.verb.approvalDenied" : "runStory.verb.approvalAllowed",
        values: { who },
        tone: p.decision === "deny" ? "error" : "done",
        ...(reason === undefined ? {} : { text: reason }),
      };
    case "rule_matched":
      return {
        ...base,
        verb: p.decision === "deny" ? "runStory.verb.ruleDenied" : "runStory.verb.ruleAllowed",
        values: { tool },
        tone: p.decision === "deny" ? "error" : "done",
      };
    case "mode_allowed":
      return { ...base, verb: "runStory.verb.modeAllowed", values: { tool }, tone: "done" };
    case "review_queued":
      return { ...base, verb: "runStory.verb.reviewing", values: { tool }, tone: "info" };
    case "expired":
      return { ...base, verb: "runStory.verb.approvalExpired", values: { tool }, tone: "warn" };
    default:
      return undefined;
  }
}

function takeoverStep(event: RunEvent): StoryStep | undefined {
  const p = event.payload;
  const base = { seq: event.seq, ts: event.ts, tone: "info" as const };
  const who = str(p.by) ?? "";
  if (p.phase === "taken") return { ...base, verb: "runStory.verb.humanTookOver", values: { who } };
  if (p.phase === "handed_back")
    return { ...base, verb: "runStory.verb.browserHandedBack", values: { who } };
  const tool = str(p.toolName);
  const waitMessage = str(p.waitMessage);
  if (tool !== undefined)
    return {
      ...base,
      verb: "runStory.verb.waitedForBrowser",
      values: { tool: shortToolName(tool) },
      tone: "warn",
      ...(waitMessage === undefined ? {} : { text: waitMessage }),
    };
  return undefined;
}

function logStep(event: RunEvent): StoryStep | undefined {
  const p = event.payload;
  const base = { seq: event.seq, ts: event.ts };
  // ADR-0048 amendment 1, A4: a desktop call refused for a network target, named by its host.
  if (isDesktopDenial(event)) {
    const reason = str(p.reason);
    return {
      ...base,
      verb: "runStory.verb.desktopEgressDenied",
      values: { host: str(p.host) ?? "?" },
      tone: "error",
      ...(reason === undefined ? {} : { text: reason }),
    };
  }
  if (p.source === "stall") {
    const idle = num(p.idleMs) ?? 0;
    return p.op === "resumed"
      ? { ...base, verb: "runStory.verb.movingAgain", values: { idleMs: idle }, tone: "done" }
      : { ...base, verb: "runStory.verb.stalled", values: { idleMs: idle }, tone: "warn" };
  }
  const text = str(p.text) ?? str(p.error);
  if (text === undefined) return undefined;
  const isError = p.level === "error" || str(p.error) !== undefined;
  return {
    ...base,
    verb:
      p.source === "assistant"
        ? "runStory.verb.said"
        : isError
          ? "runStory.verb.problem"
          : "runStory.verb.noted",
    tone: isError ? "error" : p.level === "warn" ? "warn" : "info",
    text,
  };
}

/** Model trouble reads as one step: the retries, and the switch they led to when one follows. */
function modelStep(seq: number, ts: string, retries: number, switchedTo?: string): StoryStep {
  if (switchedTo !== undefined)
    return {
      seq,
      ts,
      verb: retries > 0 ? "runStory.verb.modelRetriedThenSwitched" : "runStory.verb.modelSwitched",
      values: { retries, model: switchedTo },
      tone: "warn",
    };
  return {
    seq,
    ts,
    verb: "runStory.verb.modelRetried",
    values: { retries },
    tone: "warn",
  };
}

/**
 * The story of `events` so far. `thinking` opens a segment; everything that follows is a step of
 * it until the next thought. Steps before any thought form a segment without one.
 */
export function storyOf(events: readonly RunEvent[]): StorySegment[] {
  const rows = ledgerRows(events, { diagnostics: false });
  const segments: StorySegment[] = [];
  let current: StorySegment = { steps: [] };
  let open = false;
  let retries: { seq: number; ts: string; count: number } | undefined;

  const push = (step: StoryStep) => {
    if (!open) {
      segments.push(current);
      open = true;
    }
    current.steps.push(step);
  };
  const flushRetries = () => {
    if (retries) push(modelStep(retries.seq, retries.ts, retries.count));
    retries = undefined;
  };

  for (const row of rows) {
    if (row.kind === "tool") {
      flushRetries();
      push(toolStep(row));
      continue;
    }
    const event = row.event;
    const p = event.payload;
    if (event.kind === "model_retry") {
      retries = retries
        ? { ...retries, count: retries.count + 1 }
        : { seq: event.seq, ts: event.ts, count: 1 };
      continue;
    }
    if (event.kind === "model_switch") {
      const to = str(p.to) ?? "?";
      push(modelStep(retries?.seq ?? event.seq, retries?.ts ?? event.ts, retries?.count ?? 0, to));
      retries = undefined;
      continue;
    }
    flushRetries();
    switch (event.kind) {
      case "thinking": {
        const text = str(p.text) ?? "";
        const heading = thoughtHeading(text);
        current = {
          thought: {
            seq: event.seq,
            ts: event.ts,
            text,
            heading: heading.text,
            truncated: heading.truncated,
          },
          steps: [],
        };
        segments.push(current);
        open = true;
        break;
      }
      case "screenshot": {
        const last = current.steps.at(-1);
        if (last?.tool && last.screenshot === undefined) last.screenshot = p;
        else
          push({
            seq: event.seq,
            ts: event.ts,
            verb: "runStory.verb.tookScreenshot",
            tone: "info",
            screenshot: p,
          });
        break;
      }
      case "approval": {
        const step = approvalStep(event);
        if (step) push(step);
        break;
      }
      case "takeover": {
        const step = takeoverStep(event);
        if (step) push(step);
        break;
      }
      case "cap_breached":
        push({
          seq: event.seq,
          ts: event.ts,
          verb: "runStory.verb.capReached",
          ...obj(str(p.cap) ?? str(p.reason)),
          tone: "warn",
        });
        break;
      case "skill_used":
        push({
          seq: event.seq,
          ts: event.ts,
          verb: "runStory.verb.usedSkill",
          ...obj(str(p.skill)),
          tone: "done",
        });
        break;
      case "log": {
        const step = logStep(event);
        if (step) push(step);
        break;
      }
      default:
        // Telemetry and bookkeeping: the technical log has it.
        break;
    }
  }
  flushRetries();
  return segments;
}

/** How many steps a story has, thoughts included. */
export function storySize(segments: readonly StorySegment[]): number {
  return segments.reduce((n, s) => n + s.steps.length + (s.thought ? 1 : 0), 0);
}
