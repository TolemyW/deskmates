// ADR-0041 decision 3: one L2-normalised little-endian float32 BLOB per chunk. Normalised vectors
// make cosine similarity a dot product.

import { endianness } from "node:os";

const LITTLE_ENDIAN_HOST = endianness() === "LE";

/** The unit vector of `values`; a zero vector stays zero. */
export function normalize(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values);
  let norm = 0;
  for (let i = 0; i < out.length; i += 1) norm += (out[i] as number) * (out[i] as number);
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / norm;
  return out;
}

export function toBlob(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i] as number, i * 4);
  return buffer;
}

/** A float32 view of a stored BLOB, copied only when SQLite's buffer is unaligned. */
export function fromBlob(blob: Uint8Array): Float32Array {
  const n = blob.byteLength / 4;
  if (LITTLE_ENDIAN_HOST) {
    if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, n);
    return new Float32Array(Uint8Array.from(blob).buffer, 0, n);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Dot product; vectors of different length score -Infinity, so a stray row never wins. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number);
  return s;
}
