// T0: the byte sniffers both sides of the operation proxy apply (ADR-0040 decision 4).

import { describe, expect, it } from "vitest";
import { isPdfBytes, sniffAudio, sniffLookImage } from "./operations.js";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    Buffer.concat([
      ...parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
      Buffer.alloc(16),
    ]),
  );

describe("sniffLookImage", () => {
  it.each([
    [bytes([0x89], "PNG\r\n\u001a\n"), "image/png"],
    [bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [bytes("GIF89a"), "image/gif"],
    [bytes("RIFF", [0, 0, 0, 0], "WEBP"), "image/webp"],
  ])("%#", (input, type) => expect(sniffLookImage(input)).toBe(type));
  it("refuses text, a PDF and short input", () => {
    expect(sniffLookImage(bytes("hello world"))).toBeUndefined();
    expect(sniffLookImage(bytes("%PDF-1.7"))).toBeUndefined();
    expect(sniffLookImage(new Uint8Array([0x89, 0x50]))).toBeUndefined();
  });
});

describe("sniffAudio and isPdfBytes", () => {
  it.each([
    [bytes("RIFF", [0, 0, 0, 0], "WAVE"), "audio/wav"],
    [bytes("ID3"), "audio/mpeg"],
    [bytes([0xff, 0xfb]), "audio/mpeg"],
    [bytes("OggS"), "audio/ogg"],
    [bytes("fLaC"), "audio/flac"],
    [bytes([0x1a, 0x45, 0xdf, 0xa3]), "audio/webm"],
    [bytes([0, 0, 0, 0x20], "ftypM4A "), "audio/mp4"],
  ])("%#", (input, type) => expect(sniffAudio(input)).toBe(type));
  it("refuses an image and text", () => {
    expect(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBeUndefined();
    expect(sniffAudio(bytes("hello world"))).toBeUndefined();
  });
  it("knows a PDF header", () => {
    expect(isPdfBytes(bytes("%PDF-1.4"))).toBe(true);
    expect(isPdfBytes(bytes("PDF"))).toBe(false);
  });
});
