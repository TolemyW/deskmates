// T0 for `deskmates-sidecar file-write` (ADR-0014 amendment A5 decisions 29 to 32 and 35) on a
// real temporary directory standing for the container's `/`.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileWriteCommand, writeWorkspaceFile } from "./file-write.js";

// A disk-full write cannot be produced on a temp directory; the next write fails on demand.
const disk = vi.hoisted(() => ({ failNextWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      if (disk.failNextWrite) {
        disk.failNextWrite = false;
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
  };
});

const ID = `upl_${"a".repeat(32)}`;
const OTHER = `upl_${"b".repeat(32)}`;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "file-write-"));
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "profile"));
  writeFileSync(join(root, "profile", "Cookies"), "secret");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (request: unknown) => fileWriteCommand(JSON.stringify(request), root);
const ok = (request: unknown) => writeWorkspaceFile(request, root);
const errorOf = (request: unknown) => {
  const result = run(request);
  expect(result.exitCode).toBe(1);
  return JSON.parse(result.stdout) as { error: string; receivedBytes?: number };
};
const append = (offset: number, bytes: Buffer, uploadId = ID) =>
  ok({ op: "append", uploadId, offset, base64: bytes.toString("base64") });
const partial = (uploadId = ID) => join(root, "work", "uploads", ".partial", `${uploadId}.part`);

describe("file-write", () => {
  it("writes parts in order and commits under the date directory with a digest", () => {
    const a = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const b = Buffer.from("tail");
    expect(ok({ op: "begin", uploadId: ID })).toEqual({ op: "begin", receivedBytes: 0 });
    expect(append(0, a)).toEqual({ op: "append", receivedBytes: 256 });
    expect(append(256, b)).toEqual({ op: "append", receivedBytes: 260 });
    const all = Buffer.concat([a, b]);
    const result = ok({
      op: "commit",
      uploadId: ID,
      sizeBytes: 260,
      dir: "2026-10-14",
      name: "r.bin",
    });
    expect(result).toEqual({
      op: "commit",
      path: "/work/uploads/2026-10-14/r.bin",
      sizeBytes: 260,
      sha256: createHash("sha256").update(all).digest("hex"),
    });
    const final = join(root, "work", "uploads", "2026-10-14", "r.bin");
    expect(readFileSync(final).equals(all)).toBe(true);
    expect(fs.existsSync(partial())).toBe(false);
    // Decision 32: never executable.
    expect(statSync(final).mode & 0o111).toBe(0);
  });

  it("never overwrites: an existing name gets -2, then -3", () => {
    mkdirSync(join(root, "work", "uploads", "2026-10-14"), { recursive: true });
    writeFileSync(join(root, "work", "uploads", "2026-10-14", "a.txt"), "old");
    for (const [id, expected] of [
      [ID, "a-2.txt"],
      [OTHER, "a-3.txt"],
    ] as const) {
      ok({ op: "begin", uploadId: id });
      append(0, Buffer.from("new"), id);
      const result = ok({
        op: "commit",
        uploadId: id,
        sizeBytes: 3,
        dir: "2026-10-14",
        name: "a.txt",
      });
      expect(result).toMatchObject({ path: `/work/uploads/2026-10-14/${expected}` });
    }
    expect(readFileSync(join(root, "work", "uploads", "2026-10-14", "a.txt"), "utf8")).toBe("old");
  });

  it("refuses a part that does not start at the received length and reports the length", () => {
    ok({ op: "begin", uploadId: ID });
    append(0, Buffer.from("abc"));
    expect(
      errorOf({
        op: "append",
        uploadId: ID,
        offset: 1,
        base64: Buffer.from("x").toString("base64"),
      }),
    ).toMatchObject({ error: "offset_mismatch", receivedBytes: 3 });
  });

  it("refuses a commit before the declared size arrived", () => {
    ok({ op: "begin", uploadId: ID });
    append(0, Buffer.from("ab"));
    expect(
      errorOf({ op: "commit", uploadId: ID, sizeBytes: 5, dir: "2026-10-14", name: "x.txt" }),
    ).toMatchObject({ error: "size_mismatch", receivedBytes: 2 });
  });

  it.each([
    ["uploads", () => symlinkSync(join(root, "profile"), join(root, "work", "uploads"))],
    [
      ".partial",
      () => {
        mkdirSync(join(root, "work", "uploads"));
        symlinkSync(join(root, "profile"), join(root, "work", "uploads", ".partial"));
      },
    ],
  ])("refuses a link at %s before writing anything", (_name, plant) => {
    plant();
    expect(errorOf({ op: "begin", uploadId: ID })).toMatchObject({ error: "forbidden" });
    expect(fs.readdirSync(join(root, "profile"))).toEqual(["Cookies"]);
  });

  it("refuses a link at the date directory on commit", () => {
    ok({ op: "begin", uploadId: ID });
    append(0, Buffer.from("x"));
    symlinkSync(join(root, "profile"), join(root, "work", "uploads", "2026-10-14"));
    expect(
      errorOf({ op: "commit", uploadId: ID, sizeBytes: 1, dir: "2026-10-14", name: "x.txt" }),
    ).toMatchObject({ error: "forbidden" });
    expect(fs.readdirSync(join(root, "profile"))).toEqual(["Cookies"]);
  });

  it("refuses a partial file swapped for a link into /profile", () => {
    ok({ op: "begin", uploadId: ID });
    rmSync(partial());
    symlinkSync(join(root, "profile", "Cookies"), partial());
    expect(
      errorOf({
        op: "append",
        uploadId: ID,
        offset: 6,
        base64: Buffer.from("x").toString("base64"),
      }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      errorOf({ op: "commit", uploadId: ID, sizeBytes: 6, dir: "2026-10-14", name: "x.txt" }),
    ).toMatchObject({ error: "forbidden" });
    expect(readFileSync(join(root, "profile", "Cookies"), "utf8")).toBe("secret");
  });

  it("refuses a begin over an existing partial file", () => {
    ok({ op: "begin", uploadId: ID });
    expect(errorOf({ op: "begin", uploadId: ID })).toMatchObject({ error: "forbidden" });
  });

  it.each([
    ["bad id", { op: "begin", uploadId: "../../profile/x" }],
    ["unknown op", { op: "delete", uploadId: ID }],
    [
      "traversal in name",
      { op: "commit", uploadId: ID, sizeBytes: 0, dir: "2026-10-14", name: "../x" },
    ],
    [
      "hidden name",
      { op: "commit", uploadId: ID, sizeBytes: 0, dir: "2026-10-14", name: ".bashrc" },
    ],
    ["bad date", { op: "commit", uploadId: ID, sizeBytes: 0, dir: "../../profile", name: "x" }],
    ["negative offset", { op: "append", uploadId: ID, offset: -1, base64: "" }],
    ["non-canonical base64", { op: "append", uploadId: ID, offset: 0, base64: "a" }],
  ])("refuses %s as validation", (_name, request) => {
    expect(errorOf(request)).toMatchObject({ error: "validation" });
  });

  it("aborts by removing the partial file, and an abort of nothing is harmless", () => {
    expect(ok({ op: "abort", uploadId: ID })).toEqual({ op: "abort", removed: false });
    ok({ op: "begin", uploadId: ID });
    append(0, Buffer.from("x"));
    expect(ok({ op: "abort", uploadId: ID })).toEqual({ op: "abort", removed: true });
    expect(fs.existsSync(partial())).toBe(false);
    expect(errorOf({ op: "append", uploadId: ID, offset: 1, base64: "eA==" })).toMatchObject({
      error: "not_found",
    });
  });

  it("aborting a partial link removes the link, never its target", () => {
    ok({ op: "begin", uploadId: ID });
    rmSync(partial());
    symlinkSync(join(root, "profile", "Cookies"), partial());
    expect(ok({ op: "abort", uploadId: ID })).toEqual({ op: "abort", removed: true });
    expect(readFileSync(join(root, "profile", "Cookies"), "utf8")).toBe("secret");
  });

  it("truncates on a failed write and answers storage_exhausted", () => {
    ok({ op: "begin", uploadId: ID });
    append(0, Buffer.from("abc"));
    disk.failNextWrite = true;
    const result = errorOf({
      op: "append",
      uploadId: ID,
      offset: 3,
      base64: Buffer.from("defg").toString("base64"),
    });
    expect(result).toMatchObject({ error: "storage_exhausted", receivedBytes: 3 });
    expect(statSync(partial()).size).toBe(3);
    // The session resumes from the kept length once space is back.
    expect(append(3, Buffer.from("defg"))).toEqual({ op: "append", receivedBytes: 7 });
  });
});
