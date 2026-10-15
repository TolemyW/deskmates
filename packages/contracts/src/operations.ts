// Look/OCR and speech-to-text operations (ADR-0040): a sidecar tool reads a workspace file and
// asks the Gateway's operation proxy, which forwards one request to the installation-configured
// service and returns text. Shapes, bounds and the byte sniffers both sides apply.

/** The operations the proxy forwards (ADR-0040 decision 1). */
export type OperationName = "look" | "asr";

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
