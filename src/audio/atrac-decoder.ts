/**
 * ATRAC3 / ATRAC3+ decoder
 *
 * Parses the RIFF/WAVE header from PSP AT3 files and delegates the actual
 * PCM decode to the @ffmpeg/ffmpeg WASM instance already used by pmf.ts.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { FFmpegPool } from "./ffmpeg-pool.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("ATRAC");

/** Shared pool — lazily created on first use, sized to CPU core count. */
let sharedPool: FFmpegPool | null = null;
let decodeConcurrency = 4;

/** Max parallel decodes (matches pool size). Use to limit in-flight buffers. */
export function getDecodeConcurrency(): number {
  getPool(); // ensure pool is initialized
  return decodeConcurrency;
}

/** Pool stats for debug panel. */
export function getPoolStats(): { size: number; busy: number; waiting: number; cached: number } {
  const pool = getPool();
  return { size: pool.size, busy: pool.busy, waiting: pool.waiting, cached: pcmCache.size };
}

function getPool(): FFmpegPool {
  if (!sharedPool) {
    // Reserve 2 cores for main thread + GE worker; use the rest for decoding.
    // Minimum 2, cap at 16.
    const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    const poolSize = Math.min(16, Math.max(2, cores - 2));
    decodeConcurrency = poolSize;
    log.info(`FFmpeg pool: ${poolSize} instances (${cores} cores detected)`);
    sharedPool = new FFmpegPool({ maxSize: poolSize });
  }
  return sharedPool;
}

/** Decoded PCM cache keyed by content fingerprint. */
const pcmCache = new Map<string, Int16Array>();
/** In-progress decode promises (prevents double-decode). */
const decodePromises = new Map<string, Promise<Int16Array>>();
/** Secondary index: original AT3 byte length → {fingerprint, info} (for streaming
 *  games that call sceAtracSetDataAndGetID with an empty/uninitialized buffer). */
const sizeIndex = new Map<number, { fp: string; info: AtracInfo }>();

/** Fingerprint: length + first 32 bytes as hex. */
function fingerprint(data: Uint8Array): string {
  return `${data.byteLength}:${Array.from(data.subarray(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Synchronously look up cached PCM (returns null if not ready). */
export function getCachedAtrac(data: Uint8Array): Int16Array | null {
  return pcmCache.get(fingerprint(data)) ?? null;
}

/**
 * Look up cached PCM (and original AtracInfo) for streaming games that call
 * sceAtracSetDataAndGetID with an uninitialized buffer.
 *
 * Tries exact size first, then any cached file whose size fits inside the
 * declared buffer allocation (game allocates e.g. 131072 for a 101376-byte file).
 * `hint` is used to pick among multiple equally-sized candidates in round-robin order.
 */
export function getCachedAtracBySize(bufferAllocation: number, hint = 0): { pcm: Int16Array; info: AtracInfo; fileSize: number } | null {
  // Exact match first
  const exact = sizeIndex.get(bufferAllocation);
  if (exact) {
    const pcm = pcmCache.get(exact.fp);
    if (pcm) return { pcm, info: exact.info, fileSize: bufferAllocation };
  }
  // Find all cached files whose actual sizes fit within the allocation
  const candidates: { pcm: Int16Array; info: AtracInfo; fileSize: number }[] = [];
  for (const [size, entry] of sizeIndex) {
    if (size <= bufferAllocation) {
      const pcm = pcmCache.get(entry.fp);
      if (pcm) candidates.push({ pcm, info: entry.info, fileSize: size });
    }
  }
  if (candidates.length === 0) return null;
  // Sort descending by size so largest (most likely BGM) is first
  candidates.sort((a, b) => b.fileSize - a.fileSize);
  return candidates[hint % candidates.length]!;
}

/** Start decoding in background and cache the result. Call at ISO load time. */
export async function warmupAtracDecode(data: Uint8Array): Promise<void> {
  const key = fingerprint(data);
  if (pcmCache.has(key)) return;
  if (decodePromises.has(key)) { await decodePromises.get(key); return; }
  let info: AtracInfo;
  try { info = parseAtracHeader(data); } catch { return; }
  const p = decodeAtrac(data, info)
    .then(pcm => { pcmCache.set(key, pcm); sizeIndex.set(data.byteLength, { fp: key, info }); decodePromises.delete(key); log.info(`warmup cached: size=${data.byteLength} frames=${pcm.length/info.channels} loop=${info.loopStart}..${info.loopEnd}`); return pcm; })
    .catch(() => { decodePromises.delete(key); return new Int16Array(0); });
  decodePromises.set(key, p);
  await p;
}

/** Get a raw FFmpeg instance (for non-pool callers like PMF). */
export async function getFFmpeg(): Promise<FFmpeg> {
  return getPool().getInstance();
}

export interface AtracInfo {
  codecType: "AT3" | "AT3PLUS";
  totalSamples: number;
  loopStart: number;
  loopEnd: number;
  channels: number;
  sampleRate: number;
  samplesPerFrame: number; // 512 for AT3, 1024 for AT3+
}

/**
 * Parse the RIFF/WAVE header of a PSP AT3 file and return metadata.
 * Does not perform any decoding.
 */
export function parseAtracHeader(data: Uint8Array): AtracInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const riff = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
  const wave = String.fromCharCode(data[8]!, data[9]!, data[10]!, data[11]!);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`Not a RIFF/WAVE file (got "${riff}"/"${wave}")`);
  }

  let offset = 12;
  let codecTag   = 0;
  let channels   = 2;
  let sampleRate = 44100;
  let totalSamples = 0;
  let loopStart  = -1;
  let loopEnd    = -1;

  while (offset + 8 <= data.length) {
    const tag  = String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;

    if (tag === "fmt ") {
      codecTag   = view.getUint16(chunkStart,     true);
      channels   = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
    } else if (tag === "fact") {
      totalSamples = view.getUint32(chunkStart, true);
    } else if (tag === "smpl" && size >= 36) {
      const loopCount = view.getUint32(chunkStart + 28, true);
      if (loopCount > 0) {
        loopStart = view.getUint32(chunkStart + 36 + 8,  true);
        loopEnd   = view.getUint32(chunkStart + 36 + 12, true);
      }
    }

    offset = chunkStart + ((size + 1) & ~1); // word-align next chunk
  }

  // 0x0270 = AT3PLUS (ATRAC3plus), 0x0162 = AT3 (ATRAC3)
  const codecType      = (codecTag === 0x0270) ? "AT3PLUS" : "AT3";
  const samplesPerFrame = codecType === "AT3PLUS" ? 1024 : 512;

  return { codecType, totalSamples, loopStart, loopEnd, channels, sampleRate, samplesPerFrame };
}

/**
 * Decode an ATRAC audio file to raw signed-16-bit little-endian PCM using FFmpeg WASM.
 * Returns an Int16Array of interleaved stereo (or mono) samples.
 */
export async function decodeAtrac(data: Uint8Array, info: AtracInfo): Promise<Int16Array> {
  const key = fingerprint(data);
  const cached = pcmCache.get(key);
  if (cached) return cached;

  return getPool().exec(async (ff) => {
    // Unique filenames per decode to avoid collisions across pool instances
    const id  = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inputName  = `atrac_in_${id}.at3`;
    const outputName = `atrac_out_${id}.raw`;

    try {
      await ff.writeFile(inputName, data.slice()); // slice to prevent ISO ArrayBuffer detachment
      const ret = await ff.exec([
        "-i",  inputName,
        "-f",  "s16le",
        "-ar", String(info.sampleRate),
        "-ac", String(info.channels),
        outputName,
      ]);
      if (ret !== 0) {
        throw new Error(`FFmpeg failed to decode ATRAC (exit ${ret})`);
      }
      const raw = await ff.readFile(outputName) as Uint8Array;
      const plain = raw.slice();
      const result = new Int16Array(plain.buffer, plain.byteOffset, plain.byteLength / 2);
      pcmCache.set(key, result);
      return result;
    } finally {
      try { await ff.deleteFile(inputName);  } catch { /* ignore */ }
      try { await ff.deleteFile(outputName); } catch { /* ignore */ }
    }
  });
}
