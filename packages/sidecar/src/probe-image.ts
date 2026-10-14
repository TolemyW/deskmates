// The synthetic image of a vision probe (ADR-0023 amendment 1, decision 5): the Gateway's random
// digits drawn in a 5x7 bitmap font, black on white, as an 8-bit grayscale PNG. No font file, no
// image library, no user content: the only way to answer is to see the pixels.

import { deflateSync } from "node:zlib";

const FONT: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

const SCALE = 12;
const MARGIN = 2; // font cells

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major, one byte per pixel, 0 black and 255 white. */
  pixels: Uint8Array;
}

/** Draw `code` (digits only) with one blank font column between glyphs and a white margin. */
export function renderDigits(code: string): GrayImage {
  if (!/^\d+$/.test(code)) throw new Error("probe code must be digits");
  const columns = code.length * 6 - 1 + MARGIN * 2;
  const rows = 7 + MARGIN * 2;
  const width = columns * SCALE;
  const height = rows * SCALE;
  const pixels = new Uint8Array(width * height).fill(255);
  [...code].forEach((digit, index) => {
    const glyph = FONT[digit] as readonly string[];
    glyph.forEach((line, gy) => {
      [...line].forEach((bit, gx) => {
        if (bit !== "1") return;
        const x0 = (MARGIN + index * 6 + gx) * SCALE;
        const y0 = (MARGIN + gy) * SCALE;
        for (let y = y0; y < y0 + SCALE; y++)
          pixels.fill(0, y * width + x0, y * width + x0 + SCALE);
      });
    });
  });
  return { width, height, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode as PNG: grayscale, bit depth 8, no interlace, filter 0 on every row. */
export function encodePng(image: GrayImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 0;
  const raw = Buffer.alloc((image.width + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (image.width + 1)] = 0;
    raw.set(
      image.pixels.subarray(y * image.width, (y + 1) * image.width),
      y * (image.width + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** The probe image for `code`, as base64 PNG. */
export function probePngBase64(code: string): string {
  return encodePng(renderDigits(code)).toString("base64");
}
