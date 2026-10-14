import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, probePngBase64, renderDigits } from "./probe-image.js";

function decode(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, pixels };
}

describe("probe image", () => {
  it("encodes a PNG whose pixels are the rendered digits", () => {
    const image = renderDigits("4096");
    const decoded = decode(encodePng(image));
    expect(decoded.width).toBe(image.width);
    expect(decoded.height).toBe(image.height);
    expect(Buffer.from(decoded.pixels).equals(Buffer.from(image.pixels))).toBe(true);
  });

  it("draws different pixels for different codes and the same for the same code", () => {
    expect(probePngBase64("1234")).toBe(probePngBase64("1234"));
    expect(probePngBase64("1234")).not.toBe(probePngBase64("1235"));
  });

  it("puts ink where the glyph has it: the top bar of a 7", () => {
    const image = renderDigits("7");
    const at = (x: number, y: number) => image.pixels[y * image.width + x];
    // Margin of two cells of 12 px; the 7's first row is all ink, its second row only the last column.
    expect(at(24 + 6, 24 + 6)).toBe(0);
    expect(at(24 + 6, 36 + 6)).toBe(255);
    expect(at(24 + 4 * 12 + 6, 36 + 6)).toBe(0);
    expect(() => renderDigits("12a")).toThrow();
  });
});
