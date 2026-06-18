/**
 * Base64 helpers for embedding small binary blobs inside the save-state JSON
 * (e.g. decoded audio PCM, the GE command-register dump). Bulk memory regions
 * use raw container sections instead; this is only for binary that lives inside
 * a structured object.
 *
 * btoa/atob are globals in both the browser and node 16+. We go through a latin1
 * string in chunks so large arrays don't blow the argument-count limit.
 */

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Encode an Int16Array's bytes as base64. */
export function int16ToB64(arr: Int16Array): string {
  return bytesToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

/** Decode base64 back into an Int16Array (copies into a fresh aligned buffer). */
export function b64ToInt16(b64: string): Int16Array {
  const bytes = b64ToBytes(b64);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Int16Array(copy.buffer);
}
