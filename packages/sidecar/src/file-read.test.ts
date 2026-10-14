// T0: the `file-read` command's ADR-0014 decision 2 policy on a real temporary directory
// (`realpath` needs a filesystem). The temp directory stands in for the container's `/`.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileReadError,
  digestWorkspaceFile,
  fileReadCommand,
  readWorkspaceFile,
} from "./file-read.js";

const MIB = 1024 * 1024;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskmates-file-read-"));
  for (const dir of ["work/dir", "home/nova", "home/other-workspace-bot", "profile", "etc"])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "work/a.md"), "# result\n");
  writeFileSync(join(root, "home/nova/out.csv"), "a,b\n1,2\n");
  writeFileSync(join(root, "home/other-workspace-bot/x"), "other");
  writeFileSync(join(root, "profile/Cookies"), "session=secret");
  writeFileSync(join(root, "profile/x"), "profile file");
  writeFileSync(join(root, "etc/passwd"), "root:x:0:0");
  writeFileSync(join(root, "work/exact.bin"), Buffer.alloc(MIB, 7));
  writeFileSync(join(root, "work/big.bin"), Buffer.alloc(MIB + 1, 7));
  // A bot can plant links in the shared filesystem; the policy follows them before deciding.
  symlinkSync(join(root, "profile/Cookies"), join(root, "work/cookies-link"));
  symlinkSync("../profile/Cookies", join(root, "work/relative-link"));
  symlinkSync(join(root, "home/nova/out.csv"), join(root, "work/inside-link"));
  symlinkSync(join(root, "profile"), join(root, "work/profile-dir"));
  // A bot home that is itself a link into the profile is not an allowed root.
  symlinkSync(join(root, "profile"), join(root, "home/evil"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function verdict(path: string, maxBytes = MIB): string {
  try {
    const result = readWorkspaceFile({ path, botNames: ["nova", "evil"], maxBytes }, root);
    return `ok:${result.size}`;
  } catch (error) {
    if (error instanceof FileReadError) return error.code;
    throw error;
  }
}

describe("readWorkspaceFile", () => {
  it.each<[string, string]>([
    ["/work/a.md", "ok:9"],
    ["/home/nova/out.csv", "ok:8"],
    ["/work/inside-link", "ok:8"],
    ["/work/exact.bin", `ok:${MIB}`],
    ["/profile/Cookies", "forbidden"],
    ["/work/../profile/x", "forbidden"],
    ["/etc/passwd", "forbidden"],
    ["/home/other-workspace-bot/x", "forbidden"],
    ["/work/cookies-link", "forbidden"],
    ["/work/relative-link", "forbidden"],
    ["/work/profile-dir/Cookies", "forbidden"],
    ["/home/evil/Cookies", "forbidden"],
    ["/work/dir", "forbidden"],
    ["/work/big.bin", "payload_too_large"],
    ["/work/报告，最终.md", "forbidden"],
    ["/work/missing.md", "not_found"],
  ])("%s -> %s", (path, expected) => {
    expect(verdict(path)).toBe(expected);
  });

  it("returns the exact bytes as base64", () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    writeFileSync(join(root, "work/binary.bin"), bytes);
    const result = readWorkspaceFile(
      { path: "/work/binary.bin", botNames: [], maxBytes: MIB },
      root,
    );
    expect(Buffer.from(result.base64, "base64")).toEqual(bytes);
    expect(result.size).toBe(bytes.length);
  });

  it("applies the caller's byte cap", () => {
    expect(verdict("/work/a.md", 8)).toBe("payload_too_large");
    expect(verdict("/work/a.md", 9)).toBe("ok:9");
  });

  it("reads only the requested bounded range and reports the whole-file size", () => {
    const result = readWorkspaceFile(
      {
        path: "/work/big.bin",
        botNames: ["nova"],
        maxBytes: MIB,
        offset: MIB - 2,
        length: 4,
        allowFileAboveMaxBytes: true,
      },
      root,
    );
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.alloc(3, 7));
    expect(result).toMatchObject({ size: 3, fileSize: MIB + 1, offset: MIB - 2, eof: true });
  });

  it("rejects malformed requests", () => {
    for (const input of [
      null,
      "x",
      { path: "/work/a.md" },
      { path: "/work/a.md", botNames: "nova", maxBytes: MIB },
      { path: "/work/a.md", botNames: [1], maxBytes: MIB },
      { path: "/work/a.md", botNames: [], maxBytes: 0 },
      { path: "/work/a.md", botNames: [], maxBytes: 1.5 },
      { path: "/work/a.md", botNames: [], maxBytes: MIB, offset: -1, length: 1 },
      { path: "/work/a.md", botNames: [], maxBytes: MIB, offset: 0, length: MIB + 1 },
      { path: "/work/a.md", botNames: [], maxBytes: MIB, allowFileAboveMaxBytes: true },
      { path: 7, botNames: [], maxBytes: MIB },
    ]) {
      expect(() => readWorkspaceFile(input, root)).toThrow(FileReadError);
      try {
        readWorkspaceFile(input, root);
      } catch (error) {
        expect((error as FileReadError).code).toBe("validation");
      }
    }
  });

  it("names no filesystem detail in a refusal", () => {
    try {
      readWorkspaceFile({ path: "/work/cookies-link", botNames: [], maxBytes: MIB }, root);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain("profile");
      expect((error as Error).message).not.toContain("Cookies");
    }
  });
});

describe("fileReadCommand", () => {
  it("prints {base64, size} and exits 0 on success", () => {
    const out = fileReadCommand(
      JSON.stringify({ path: "/work/a.md", botNames: ["nova"], maxBytes: MIB }),
      root,
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { base64: string; size: number };
    expect(Buffer.from(parsed.base64, "base64").toString()).toBe("# result\n");
    expect(parsed.size).toBe(9);
  });

  it("prints {error, message} and exits non-zero on a refusal or bad stdin", () => {
    const refused = fileReadCommand(
      JSON.stringify({ path: "/profile/Cookies", botNames: ["nova"], maxBytes: MIB }),
      root,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ error: "forbidden" });
    const garbage = fileReadCommand("not json", root);
    expect(garbage.exitCode).not.toBe(0);
    expect(JSON.parse(garbage.stdout)).toMatchObject({ error: "validation" });
  });
});

describe("digest mode (ADR-0014 A4 decision 23)", () => {
  const digest = (path: string, maxBytes = MIB) =>
    fileReadCommand(
      JSON.stringify({ path, botNames: ["nova", "evil"], maxBytes, digest: true }),
      root,
    );

  it("returns the size and SHA-256 of an allowed regular file, not its content", () => {
    const out = digest("/work/a.md");
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      fileSize: 9,
      sha256: createHash("sha256").update("# result\n").digest("hex"),
    });
    const linked = digestWorkspaceFile(
      { path: "/work/inside-link", botNames: ["nova"], maxBytes: MIB, digest: true },
      root,
    );
    expect(linked.fileSize).toBe(8);
  });

  it("applies the read policy: missing, protected, symlink escape, directory, oversized", () => {
    const code = (path: string) => (JSON.parse(digest(path).stdout) as { error?: string }).error;
    expect(code("/work/missing.md")).toBe("not_found");
    expect(code("/profile/Cookies")).toBe("forbidden");
    expect(code("/work/cookies-link")).toBe("forbidden");
    expect(code("/work/relative-link")).toBe("forbidden");
    expect(code("/work/dir")).toBe("forbidden");
    expect(code("/home/evil/Cookies")).toBe("forbidden");
    expect(code("/work/big.bin")).toBe("payload_too_large");
  });

  it("refuses a range in digest mode and digest in read mode", () => {
    expect(() =>
      digestWorkspaceFile(
        { path: "/work/a.md", botNames: [], maxBytes: MIB, digest: true, length: 4 },
        root,
      ),
    ).toThrow(FileReadError);
    expect(() =>
      readWorkspaceFile({ path: "/work/a.md", botNames: [], maxBytes: MIB, digest: true }, root),
    ).toThrow(FileReadError);
  });
});
