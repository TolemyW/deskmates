// Look/OCR and speech-to-text operations (ADR-0040): a sidecar tool reads a workspace file and
// asks the Gateway's operation proxy, which forwards one request to the installation-configured
// service and returns text. Shapes, bounds and the byte sniffers both sides apply.

/**
 * The operations the proxy forwards (ADR-0040 decision 1); `image_generation` is text-to-image
 * (amendment B, decision 16).
 */
export type OperationName = "look" | "asr" | "image_generation";

/** `look` modes: transcribe the text exactly, or describe the image. */
export type LookMode = "ocr" | "describe";

/** Billing units (design #115 §8.1, the subset these operations use). */
export type OperationUnit = "image" | "page" | "audio_second";

/** Whether a quantity was counted by Deskmates, reported by the service, or is unknown. */
export type OperationMeasured = "computed" | "provider" | "unknown";

export type LookMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type AudioMediaType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/flac"
  | "audio/webm"
  | "audio/mp4";

/** Largest image the `look` operation accepts (decision 4). */
export const LOOK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Largest PDF `image_describe` opens (decision 4). */
export const LOOK_PDF_MAX_BYTES = 50 * 1024 * 1024;
/** Pages one `image_describe` call reads (decision 5). */
export const LOOK_PDF_MAX_PAGES = 10;
/** Pages read when the call names none (decision 5). */
export const LOOK_PDF_DEFAULT_PAGES = 5;
/** A page with fewer non-space characters in its text layer is treated as scanned (decision 5). */
export const LOOK_TEXT_LAYER_MIN_CHARS = 16;
/** Longest question a `look` call carries (decision 4). */
export const LOOK_QUESTION_MAX_CHARS = 2000;
/** Default audio size bound; `ASR_OPERATION_MAX_BYTES` overrides it (decision 4). */
export const ASR_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Default audio duration bound; `ASR_OPERATION_MAX_SECONDS` overrides it (decision 6). */
export const ASR_DEFAULT_MAX_SECONDS = 1800;
/** A language hint: two or three lower-case letters (ISO 639-1 or -3). */
export const ASR_LANGUAGE = /^[a-z]{2,3}$/;

/** Where the input came from, for the ledger and the receipt; never read by the Gateway. */
export interface OperationSource {
  path: string;
  /** 1-based PDF page, when the image is a rendered page. */
  page?: number;
}

/** `POST /internal/runs/:runId/operations/look`. */
export interface LookOperationRequest {
  mode: LookMode;
  question?: string;
  mediaType: LookMediaType;
  /** The image bytes, base64. */
  data: string;
  /** `image` for an image file, `page` for a rendered PDF page. */
  unit: "image" | "page";
  source: OperationSource;
}

/** `POST /internal/runs/:runId/operations/asr`. */
export interface AsrOperationRequest {
  mediaType: AudioMediaType;
  data: string;
  /** The file's base name, sent to the service as the multipart file name. */
  fileName: string;
  language?: string;
  /** Seconds computed from the bytes by the sidecar (WAV only), else absent. */
  durationSeconds?: number;
  source: OperationSource;
}

export interface OperationUsage {
  unit: OperationUnit;
  quantity: number | null;
  measured: OperationMeasured;
  inputTokens: number | null;
  outputTokens: number | null;
  /** quantity × configured price; null when unpriced or the quantity is unknown. */
  costUsd: number | null;
}

export interface LookOperationResponse {
  operationId: string;
  model: string;
  text: string;
  usage: OperationUsage;
}

export interface AsrOperationResponse {
  operationId: string;
  model: string;
  text: string;
  language: string | null;
  durationSeconds: number | null;
  usage: OperationUsage;
}

/** Longest prompt an `image_generation` call carries (amendment B, decision 19). */
export const IMAGE_PROMPT_MAX_CHARS = 4000;
/** Images one `image_generation` call may ask for (decision 19). */
export const IMAGE_MAX_COUNT = 4;
/** Smallest and largest side of a generated image, in pixels; sides are multiples of 64. */
export const IMAGE_SIDE_MIN = 256;
export const IMAGE_SIDE_MAX = 2048;
/** Size used when neither the call nor `IMAGE_OPERATION_DEFAULT_SIZE` names one (decision 17). */
export const IMAGE_DEFAULT_SIZE = "1024x1024";
/** Largest generated image the Gateway accepts from the service (decision 19). */
export const IMAGE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export type GeneratedImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/**
 * A `<width>x<height>` size within the bounds, as `[width, height]`, or undefined when it is not
 * one (decision 19).
 */
export function parseImageSize(size: string): [number, number] | undefined {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!match) return undefined;
  const sides: [number, number] = [Number(match[1]), Number(match[2])];
  return sides.every((n) => n >= IMAGE_SIDE_MIN && n <= IMAGE_SIDE_MAX && n % 64 === 0)
    ? sides
    : undefined;
}

/** `POST /internal/runs/:runId/operations/image_generation`. */
export interface ImageGenerationRequest {
  prompt: string;
  /** `<width>x<height>`; absent: the installation default. */
  size?: string;
  /** 1 to `IMAGE_MAX_COUNT`; absent: 1. */
  count?: number;
}

export interface GeneratedImage {
  mediaType: GeneratedImageMediaType;
  /** The image bytes, base64. */
  data: string;
  bytes: number;
  sha256: string;
  /** From the image header; null when Deskmates cannot read it, never guessed. */
  width: number | null;
  height: number | null;
}

export interface ImageGenerationResponse {
  operationId: string;
  model: string;
  images: GeneratedImage[];
  /** The service's rewritten prompt when it returned one: untrusted text. */
  revisedPrompt: string | null;
  usage: OperationUsage;
}

/** The run-config stamp of one configured operation (decision 2). */
export interface OperationStamp {
  model: string;
  endpointSha256: string;
}

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The media type of an image the `look` operation accepts, from its first bytes. */
export function sniffLookImage(bytes: Uint8Array): LookMediaType | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 8) === "PNG\r\n\u001a\n") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Whether the bytes start like a PDF. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-";
}

/** The media type of an audio file the `asr` operation accepts, from its first bytes. */
export function sniffAudio(bytes: Uint8Array): AudioMediaType | undefined {
  if (bytes.length < 12) return undefined;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  // An MPEG audio frame sync: 11 set bits.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "audio/webm";
  if (ascii(bytes, 4, 8) === "ftyp") return "audio/mp4";
  return undefined;
}

/** The media type of a generated image: PNG, JPEG or WebP (amendment B, decision 19). */
export function sniffGeneratedImage(bytes: Uint8Array): GeneratedImageMediaType | undefined {
  const type = sniffLookImage(bytes);
  return type === "image/gif" ? undefined : type;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) + (b[i + 2] ?? 0) * 65536;
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);

/**
 * Pixel width and height from a PNG, JPEG or WebP header, or undefined when the header does not
 * say: an unreadable size is unknown, never guessed (decision 19).
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const type = sniffGeneratedImage(bytes);
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;
  if (type === "image/png") {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return undefined;
    return ok(u32be(bytes, 16), u32be(bytes, 20));
  }
  if (type === "image/webp") {
    if (bytes.length < 30) return undefined;
    const chunk = ascii(bytes, 12, 16);
    if (chunk === "VP8X") return ok(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
    if (chunk === "VP8 ") return ok(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const b = (i: number) => bytes[21 + i] ?? 0;
      const width = 1 + (b(0) | ((b(1) & 0x3f) << 8));
      const height = 1 + ((b(1) >> 6) | (b(2) << 2) | ((b(3) & 0x0f) << 10));
      return ok(width, height);
    }
    return undefined;
  }
  if (type === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return ok(u16be(bytes, i + 7), u16be(bytes, i + 5));
      const length = u16be(bytes, i + 2);
      if (length < 2) return undefined;
      i += 2 + length;
    }
  }
  return undefined;
}
