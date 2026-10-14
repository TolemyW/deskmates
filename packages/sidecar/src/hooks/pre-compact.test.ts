// T0: the PreCompact hook keeps a copy of the transcript the SDK is about to compact, and never
// stands in the way of compaction (M3 context plan, Phase 1).

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { RunId, SidecarEvent } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { EventSink } from "../ledger.js";
import { createMemoryFs } from "../testing/in-memory-fs.js";
import { compactArchivePath, createPreCompactHook } from "./pre-compact.js";

const HOME = "/home/nova";
const NOW = new Date("2026-09-29T10:11:12.345Z");

function setup(files: Record<string, string>) {
  const fs = createMemoryFs(files);
  const posted: SidecarEvent[] = [];
  const sink = new EventSink({
    runId: "run-1" as RunId,
    attempt: 1,
    post: async (batch) => {
      posted.push(...batch);
    },
    redact: (p) => p,
    now: () => NOW,
    batchDelayMs: 1,
  });
  const hook = createPreCompactHook({ botHomeDir: HOME, fs, sink, now: () => NOW });
  return { fs, sink, hook };
}

const input = (transcriptPath: string): HookInput => ({
  hook_event_name: "PreCompact",
  session_id: "sess-1",
  transcript_path: transcriptPath,
  cwd: "/work",
  trigger: "auto",
  custom_instructions: null,
});

const signal = new AbortController().signal;

describe("PreCompact archive", () => {
  it("names the archive after the session and the time, under the bot's .claude", () => {
    expect(compactArchivePath(HOME, "sess-1", NOW)).toBe(
      `${HOME}/.claude/compact-archive/sess-1-2026-09-29T10-11-12-345Z.jsonl`,
    );
    expect(compactArchivePath(HOME, "../x/y", NOW)).toBe(
      `${HOME}/.claude/compact-archive/.._x_y-2026-09-29T10-11-12-345Z.jsonl`,
    );
  });

  it("copies the transcript and ledgers a log event naming the archive", async () => {
    const transcript = `${HOME}/.claude/projects/-work/sess-1.jsonl`;
    const { fs, sink, hook } = setup({ [transcript]: '{"a":1}\n{"b":2}\n' });
    const out = await hook(input(transcript), undefined, { signal });
    expect(out).toEqual({ continue: true });
    const archive = compactArchivePath(HOME, "sess-1", NOW);
    expect(fs.files.get(archive)).toBe('{"a":1}\n{"b":2}\n');
    expect(sink.emitted.map((e) => [e.kind, e.payload])).toEqual([
      [
        "log",
        {
          source: "pre_compact",
          op: "archived",
          trigger: "auto",
          archivePath: archive,
          chars: 16,
        },
      ],
    ]);
  });

  it("fails open: a missing transcript is logged and compaction goes ahead", async () => {
    const { sink, hook } = setup({});
    const out = await hook(input("/nowhere.jsonl"), undefined, { signal });
    expect(out).toEqual({ continue: true });
    expect(sink.emitted[0]?.payload).toMatchObject({
      source: "pre_compact",
      op: "archive_failed",
      level: "warn",
    });
  });

  it("archives a new session whose transcript becomes readable after the hook starts", async () => {
    vi.useFakeTimers();
    try {
      const transcript = `${HOME}/.claude/projects/-work/sess-1.jsonl`;
      const text = '{"type":"user","message":"keep this original"}\n';
      const { fs, sink, hook } = setup({});
      const read = fs.readFile;
      let notWritten = true;
      vi.spyOn(fs, "readFile").mockImplementation(async (path) => {
        if (notWritten) {
          notWritten = false;
          fs.files.set(transcript, text);
          throw Object.assign(new Error("transcript write pending"), { code: "ENOENT" });
        }
        return read(path);
      });
      const pending = hook(input(transcript), undefined, { signal });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ continue: true });
      expect(fs.files.get(compactArchivePath(HOME, "sess-1", NOW))).toBe(text);
      expect(sink.emitted[0]?.payload.op).toBe("archived");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for content rather than archiving an empty new transcript", async () => {
    vi.useFakeTimers();
    try {
      const transcript = `${HOME}/.claude/projects/-work/sess-1.jsonl`;
      const text = '{"type":"user","message":"written after creation"}\n';
      const { fs, hook } = setup({ [transcript]: "" });
      const read = fs.readFile;
      let empty = true;
      vi.spyOn(fs, "readFile").mockImplementation(async (path) => {
        if (empty) {
          empty = false;
          fs.files.set(transcript, text);
          return "";
        }
        return read(path);
      });
      const pending = hook(input(transcript), undefined, { signal });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ continue: true });
      expect(fs.files.get(compactArchivePath(HOME, "sess-1", NOW))).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open within a bounded wait when a new transcript never appears", async () => {
    vi.useFakeTimers();
    try {
      const { fs, sink, hook } = setup({});
      vi.spyOn(fs, "readFile").mockRejectedValue(
        Object.assign(new Error("still absent"), { code: "ENOENT" }),
      );
      const started = Date.now();
      const pending = hook(input("/missing.jsonl"), undefined, { signal });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ continue: true });
      expect(Date.now() - started).toBeLessThanOrEqual(2_000);
      expect(sink.emitted[0]?.payload.op).toBe("archive_failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait or retry a permission refusal", async () => {
    const { fs, sink, hook } = setup({});
    const read = vi
      .spyOn(fs, "readFile")
      .mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    expect(await hook(input("/denied.jsonl"), undefined, { signal })).toEqual({ continue: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(sink.emitted[0]?.payload.op).toBe("archive_failed");
  });

  it("waits for an observed tool result even when a nonempty transcript already exists", async () => {
    vi.useFakeTimers();
    try {
      const transcript = "/session.jsonl";
      const prefix = '{"type":"assistant","uuid":"before"}\n';
      const full = `${prefix}{"type":"user","uuid":"result-1","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1"}]}}\n`;
      const { fs, sink } = setup({ [transcript]: prefix });
      const hook = createPreCompactHook({
        botHomeDir: HOME,
        fs,
        sink,
        now: () => NOW,
        latestToolResultUuid: () => "result-1",
      });
      setTimeout(() => fs.files.set(transcript, full), 200);
      const pending = hook(input(transcript), undefined, { signal });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ continue: true });
      expect(fs.files.get(compactArchivePath(HOME, "sess-1", NOW))).toBe(full);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report a partial JSON record containing the expected UUID as archived", async () => {
    vi.useFakeTimers();
    try {
      const { fs, sink } = setup({
        "/session.jsonl": '{"type":"user","uuid":"result-1","message":',
      });
      const hook = createPreCompactHook({
        botHomeDir: HOME,
        fs,
        sink,
        now: () => NOW,
        latestToolResultUuid: () => "result-1",
      });
      const pending = hook(input("/session.jsonl"), undefined, { signal });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ continue: true });
      expect(sink.emitted[0]?.payload.op).toBe("archive_failed");
      expect(fs.files.has(compactArchivePath(HOME, "sess-1", NOW))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores any other hook event", async () => {
    const { sink, hook } = setup({});
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/t",
        cwd: "/work",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "t1",
      },
      "t1",
      { signal },
    );
    expect(out).toEqual({ continue: true });
    expect(sink.emitted).toEqual([]);
  });
});
