import { describe, expect, it } from "vitest";
import {
  IMAGE_ZOOM_STEPS,
  PDF_MAX_CANVAS_PIXELS,
  PDF_ZOOM_STEPS,
  parsePageNumber,
  pdfCanvasScale,
  stepZoom,
} from "./preview-zoom.js";

describe("preview zoom (ADR-0014 A6 decision 38)", () => {
  it("keeps image zoom between 25% and 400%", () => {
    expect(stepZoom(IMAGE_ZOOM_STEPS, 1, 1)).toBe(1.5);
    expect(stepZoom(IMAGE_ZOOM_STEPS, 4, 1)).toBe(4);
    expect(stepZoom(IMAGE_ZOOM_STEPS, 0.25, -1)).toBe(0.25);
    // A fitted image can be at any scale; the next step is the nearest one.
    expect(stepZoom(IMAGE_ZOOM_STEPS, 0.6, 1)).toBe(0.75);
    expect(stepZoom(IMAGE_ZOOM_STEPS, 0.6, -1)).toBe(0.5);
  });

  it("keeps PDF zoom between 50% and 300%", () => {
    expect(stepZoom(PDF_ZOOM_STEPS, 3, 1)).toBe(3);
    expect(stepZoom(PDF_ZOOM_STEPS, 0.5, -1)).toBe(0.5);
  });

  it("accepts only page numbers that exist", () => {
    expect(parsePageNumber("3", 5)).toBe(3);
    for (const input of ["0", "6", "-1", "2.5", "x", ""])
      expect(parsePageNumber(input, 5), input).toBeUndefined();
  });

  it("caps the PDF canvas at 16 million device pixels", () => {
    expect(pdfCanvasScale(600, 800, 1, 2)).toBe(2);
    const scale = pdfCanvasScale(600, 800, 3, 2);
    expect(600 * scale * 800 * scale).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS + 1);
    expect(scale).toBeLessThan(6);
  });
});
