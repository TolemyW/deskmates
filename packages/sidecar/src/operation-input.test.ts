// T1 (local temp files only): what the look/OCR and speech tools may read, and how pages and
// WAV durations are computed before any bytes leave the container (ADR-0040 decisions 4 to 6).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OperationInputError,
  createOperationFiles,
  parsePages,
  textLayerChars,
  wavDurationSeconds,
} from "./operation-input.js";

const root = mkdtempSync(join(tmpdir(), "deskmates-op-input-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["work/sub", "home/nova", "tmp", "profile"])
  mkdirSync(join(root, dir), { recursive: true });
writeFileSync(join(root, "work/sub/a.png"), "PNGDATA");
writeFileSync(join(root, "home/nova/b.wav"), "WAVDATA");
writeFileSync(join(root, "profile/Cookies"), "secret");
writeFileSync(join(root, "work/big.bin"), Buffer.alloc(100));
symlinkSync(join(root, "profile/Cookies"), join(root, "work/cookies.png"));
symlinkSync(join(root, "home/nova/b.wav"), join(root, "work/link.wav"));

const files = createOperationFiles({ root });

describe("createOperationFiles.read", () => {
  it("reads regular files under /work, /home and /tmp, following links that stay inside", async () => {
    expect((await files.read("/work/sub/a.png", 1000)).bytes.toString()).toBe("PNGDATA");
    expect((await files.read("/home/nova/b.wav", 1000)).bytes.toString()).toBe("WAVDATA");
    expect((await files.read("/work/link.wav", 1000)).bytes.toString()).toBe("WAVDATA");
  });

  it.each([
    "/profile/Cookies",
    "/work/cookies.png",
    "/work/../profile/Cookies",
    "work/sub/a.png",
    "/work/sub",
    "/etc/passwd",
    "/work/missing.png",
  ])("refuses %s", async (path) => {
    await expect(files.read(path, 1000)).rejects.toBeInstanceOf(OperationInputError);
  });

  it("refuses a file above the bound before reading it", async () => {
    await expect(files.read("/work/big.bin", 99)).rejects.toThrow(/100 bytes; the limit is 99/);
  });
});

describe("parsePages", () => {
  it("defaults to the first pages and parses ranges and lists", () => {
    expect(parsePages(undefined, 12, 10, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(parsePages("", 2, 10, 5)).toEqual([1, 2]);
    expect(parsePages("3", 12, 10, 5)).toEqual([3]);
    expect(parsePages("2,5, 7-8,5", 12, 10, 5)).toEqual([2, 5, 7, 8]);
  });
  it.each([
    ["0", /not like/],
    ["3-1", /not like/],
    ["a", /not like/],
    ["13", /page 13 does not exist/],
    ["1-11", /at most 10/],
    ["1-6,7-12", /at most 10/],
  ])("refuses %s", (spec, error) => {
    expect(() => parsePages(spec, 12, 10, 5)).toThrow(error);
  });
});

function wav(seconds: number, byteRate = 32000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * byteRate));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(byteRate, 16);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "latin1");
  dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dataHead, data]);
}

describe("wavDurationSeconds and textLayerChars", () => {
  it("computes a PCM WAV's seconds from its header", () => {
    expect(wavDurationSeconds(wav(2.5))).toBeCloseTo(2.5);
  });
  it("is undefined for other bytes", () => {
    expect(wavDurationSeconds(Buffer.from("OggS................"))).toBeUndefined();
  });
  it("counts non-space characters", () => {
    expect(textLayerChars("  \n\f  ")).toBe(0);
    expect(textLayerChars(" a b\nc ")).toBe(3);
  });
});
