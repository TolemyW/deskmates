/** Zoom and page bounds of the preview viewers (ADR-0014 amendment A6 decision 38). */
export const IMAGE_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;
/** Largest PDF canvas, in device pixels, whatever the zoom. */
export const PDF_MAX_CANVAS_PIXELS = 16_000_000;

/** The next step above or below `current`; stays at the end of the range. */
export function stepZoom(steps: readonly number[], current: number, direction: 1 | -1): number {
  if (direction > 0) return steps.find((step) => step > current + 1e-9) ?? (steps.at(-1) as number);
  return [...steps].reverse().find((step) => step < current - 1e-9) ?? (steps[0] as number);
}

/** A requested page number inside 1..pages, or undefined when it is not one. */
export function parsePageNumber(input: string, pages: number): number | undefined {
  if (!/^\d+$/.test(input.trim())) return undefined;
  const page = Number(input.trim());
  return page >= 1 && page <= pages ? page : undefined;
}

/**
 * The device-pixel scale for one PDF page: the CSS scale times the device ratio, reduced so the
 * canvas stays within `maxPixels`.
 */
export function pdfCanvasScale(
  baseWidth: number,
  baseHeight: number,
  cssScale: number,
  ratio: number,
  maxPixels = PDF_MAX_CANVAS_PIXELS,
): number {
  const wanted = cssScale * ratio;
  const pixels = baseWidth * wanted * baseHeight * wanted;
  return pixels <= maxPixels ? wanted : Math.sqrt(maxPixels / (baseWidth * baseHeight));
}
