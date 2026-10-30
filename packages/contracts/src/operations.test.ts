// T0: the byte sniffers both sides of the operation proxy apply (ADR-0040 decision 4).

import { describe, expect, it } from "vitest";
import {
  imageDimensions,
  isPdfBytes,
  parseImageSize,
  sniffAudio,
  sniffGeneratedImage,
  sniffLookImage,
} from "./operations.js";

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

// ADR-0040 amendment B, decision 19: generated images, their bounds and their pixel sizes.
describe("generated images", () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
  const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
  const png = (w: number, h: number) =>
    bytes([0x89], "PNG\r\n\u001a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
  const jpeg = (w: number, h: number) =>
    bytes(
      [0xff, 0xd8, 0xff, 0xe0, 0, 16],
      "JFIF\u0000",
      [1, 1, 0, 0, 1, 0, 1, 0, 0],
      [0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3],
    );
  const webpX = (w: number, h: number) =>
    bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBP",
      "VP8X",
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      le24(w - 1),
      le24(h - 1),
    );
  const webpLossy = (w: number, h: number) =>
    bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBP",
      "VP8 ",
      [0, 0, 0, 0],
      [0, 0, 0],
      [0x9d, 0x01, 0x2a],
      le16(w),
      le16(h),
    );
  const webpLossless = (w: number, h: number) => {
    const bits = (w - 1) | ((h - 1) << 14);
    const le = [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255];
    return bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], le);
  };

  it("reads PNG, JPEG and the three WebP headers", () => {
    expect(imageDimensions(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpX(1536, 1024))).toEqual({ width: 1536, height: 1024 });
    expect(imageDimensions(webpLossy(512, 256))).toEqual({ width: 512, height: 256 });
    expect(imageDimensions(webpLossless(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it("says nothing it cannot read, and refuses a GIF as a generated image", () => {
    expect(imageDimensions(bytes([0x89], "PNG\r\n\u001a\n", be32(13), "XXXX"))).toBeUndefined();
    expect(imageDimensions(bytes([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(sniffGeneratedImage(bytes("GIF89a"))).toBeUndefined();
    expect(sniffGeneratedImage(png(1, 1))).toBe("image/png");
  });

  it("accepts sizes of multiples of 64 between 256 and 2048 only", () => {
    expect(parseImageSize("1024x1024")).toEqual([1024, 1024]);
    expect(parseImageSize("256x2048")).toEqual([256, 2048]);
    for (const bad of ["1000x1000", "128x128", "4096x1024", "1024", "1024x1024 ", "1024X1024"])
      expect(parseImageSize(bad), bad).toBeUndefined();
  });
});
