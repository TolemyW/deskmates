// T1 (ADR-0014 A4 decision 23): the Gateway half of formal-file verification. The policy itself
// is proven on a real filesystem in packages/sidecar/src/file-read.test.ts ("digest mode").
import type { ExecRequest, SandboxHandle } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../context.js";
import { verifyWorkspaceFiles } from "./file-verification.js";

const handle = { workspaceId: "ws", providerRef: "p" } as unknown as SandboxHandle;
const SHA = "f".repeat(64);

function fake(running: boolean, reply: (req: ExecRequest) => { exitCode: number; out: unknown }) {
  const exec = vi.fn(async (_h: SandboxHandle, req: ExecRequest) => {
    const r = reply(req);
    return {
      exitCode: r.exitCode,
      stdout: `${JSON.stringify(r.out)}\n`,
      stderr: "",
      timedOut: false,
    };
  });
  const ctx = {
    sandboxes: { peek: vi.fn(async () => (running ? handle : undefined)), ensure: vi.fn() },
    provider: { exec },
    bots: { list: () => [{ name: "nova" }] },
    config: {},
  } as unknown as GatewayContext;
  return { ctx, exec };
}

describe("verifyWorkspaceFiles", () => {
  it("checks every path with the fixed digest command and records the check", async () => {
    const { ctx, exec } = fake(true, () => ({ exitCode: 0, out: { fileSize: 3, sha256: SHA } }));
    const at = new Date("2026-10-13T12:00:00.000Z");
    const verified = await verifyWorkspaceFiles(ctx, "ws" as never, ["/work/a.md"], () => at);
    expect(verified.get("/work/a.md")).toEqual({
      path: "/work/a.md",
      sizeBytes: 3,
      sha256: SHA,
      check: "file-read-digest-v1",
      checkedAt: at.toISOString(),
    });
    const req = exec.mock.calls[0]?.[1] as ExecRequest;
    expect(req.cmd).toEqual(["deskmates-sidecar", "file-read"]);
    expect(JSON.parse(req.stdin ?? "")).toMatchObject({ path: "/work/a.md", digest: true });
  });

  it("refuses a stopped workspace without starting it", async () => {
    const { ctx, exec } = fake(false, () => ({ exitCode: 0, out: {} }));
    await expect(verifyWorkspaceFiles(ctx, "ws" as never, ["/work/a.md"])).rejects.toMatchObject({
      details: { reason: "workspace_not_running" },
    });
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.sandboxes.ensure).not.toHaveBeenCalled();
  });

  it("names every failure: lexical, refused, missing and malformed", async () => {
    const { ctx } = fake(true, (req) => {
      const path = (JSON.parse(req.stdin ?? "") as { path: string }).path;
      if (path === "/work/link") return { exitCode: 1, out: { error: "forbidden" } };
      if (path === "/work/old") return { exitCode: 0, out: { base64: "", size: 0 } };
      return { exitCode: 1, out: { error: "not_found" } };
    });
    await expect(
      verifyWorkspaceFiles(ctx, "ws" as never, [
        "/profile/Cookies",
        "/work/link",
        "/work/gone",
        "/work/old",
      ]),
    ).rejects.toMatchObject({
      code: "validation",
      details: {
        errors: [
          "/profile/Cookies: forbidden (only /work/ or /home/<bot>/ of this workspace)",
          "/work/link: forbidden",
          "/work/gone: not_found",
          "/work/old: invalid_response",
        ],
      },
    });
  });
});
