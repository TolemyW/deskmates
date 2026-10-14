import { afterEach, describe, expect, it, vi } from "vitest";
import { riskTier } from "./risk-tier.js";
import { toToolAction } from "./tool-action.js";
import { type PtyProcess, TtySessions } from "./tty-session.js";

function fixture() {
  let output: (data: string) => void = () => {};
  let exited: (value: { exitCode: number }) => void = () => {};
  const child: PtyProcess = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => {
      output = cb;
      return { dispose: vi.fn() };
    },
    onExit: (cb) => {
      exited = cb;
      return { dispose: vi.fn() };
    },
  };
  const spawn = vi.fn(async () => child);
  return {
    sessions: new TtySessions(spawn, async () => {}),
    spawn,
    child,
    output: (text: string) => output(text),
    exited: (code: number) => exited({ exitCode: code }),
  };
}
afterEach(() => vi.useRealTimers());
describe("run-owned terminal lifecycle", () => {
  it("supports bounded incremental output, control keys, resize, exit and ownership", async () => {
    const f = fixture();
    try {
      const opened = await f.sessions.execute({ action: "open", command: "bash" });
      const sessionId = opened.sessionId;
      f.output("x".repeat(70_000));
      const read = await f.sessions.execute({ action: "read", sessionId });
      expect(String(read.output).length).toBe(65536);
      expect(read.droppedCharacters).toBe(4464);
      expect((await f.sessions.execute({ action: "read", sessionId })).output).toBe("");
      await f.sessions.execute({ action: "write", sessionId, data: "\u0003" });
      expect(f.child.write).toHaveBeenCalledWith("\u0003");
      await f.sessions.execute({ action: "resize", sessionId, cols: 120, rows: 40 });
      expect(f.child.resize).toHaveBeenCalledWith(120, 40);
      await expect(
        f.sessions.execute({ action: "write", sessionId: "other-run", data: "yes\r" }),
      ).rejects.toThrow("Unknown terminal");
      f.exited(9);
      expect(await f.sessions.execute({ action: "read", sessionId })).toMatchObject({
        closed: true,
        exitCode: 9,
      });
      await expect(f.sessions.execute({ action: "write", sessionId, data: "yes" })).rejects.toThrow(
        "exited",
      );
    } finally {
      f.sessions.dispose();
    }
  });
  it("kills time-limited sessions and ends every session with the run", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { sessionId } = await f.sessions.execute({
      action: "open",
      command: "bash",
      timeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(await f.sessions.execute({ action: "read", sessionId })).toMatchObject({
      closed: true,
      timedOut: true,
    });
    await f.sessions.execute({ action: "open", command: "bash" });
    f.sessions.dispose();
    expect(f.child.kill).toHaveBeenCalledTimes(2);
    await expect(f.sessions.execute({ action: "open", command: "bash" })).rejects.toThrow(
      "owner has ended",
    );
  });
  it("reserves concurrent opens and rejects invalid working directories", async () => {
    const f = fixture();
    try {
      await expect(
        f.sessions.execute({ action: "open", command: "bash", cwd: "../../etc" }),
      ).rejects.toThrow("under /work");
      await Promise.all(
        Array.from({ length: 4 }, () => f.sessions.execute({ action: "open", command: "bash" })),
      );
      await expect(f.sessions.execute({ action: "open", command: "bash" })).rejects.toThrow(
        "limit 4",
      );
      expect(f.spawn).toHaveBeenCalledTimes(4);
    } finally {
      f.sessions.dispose();
    }
  });
  it("requires approval for every open and every write that is not a harmless complete line, and hashes complete arguments for repeat decisions", () => {
    const tool = "mcp__deskmates__tty_session";
    expect(riskTier(tool, { action: "open", command: "pwd" })).toBe("L2");
    // ADR-0002 amendment 3, A5: a complete line is tiered by the shell rules, so a harmless one
    // is L1 (it was L2 before the amendment) and a destructive one still asks.
    expect(riskTier(tool, { action: "write", data: "yes\r" })).toBe("L1");
    expect(riskTier(tool, { action: "write", data: "git push\r" })).toBe("L2");
    expect(riskTier(tool, { action: "write", data: "yes" })).toBe("L2");
    expect(riskTier(tool, { action: "read" })).toBe("L0");
    const a = toToolAction(tool, { action: "write", data: `${"x".repeat(300)}yes` });
    const b = toToolAction(tool, { action: "write", data: `${"x".repeat(300)}no` });
    expect(a.argumentPattern).not.toBe(b.argumentPattern);
    expect(a.argumentSummary).toContain("write 303 characters");
    expect(a.argumentPattern?.startsWith("* ")).toBe(true);
  });
});
