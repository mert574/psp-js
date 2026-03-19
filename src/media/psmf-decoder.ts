/**
 * PSMF (PSP Movie Format) H.264 decoder using WebCodecs.
 *
 * Isolated module with no frontend dependencies (no DOM, no Logger).
 * Can be used standalone or wrapped by a UI player.
 *
 * Pipeline:
 * 1. Extract raw H.264 ES from PSMF container (PES demux)
 * 2. Parse Annex B NAL units → find SPS/PPS
 * 3. Group NALs into access units by AUD boundaries
 * 4. Feed to WebCodecs VideoDecoder in avcC format
 */

// ── Types ───────────────────────────────────────────────────────────────────

import { Logger } from "../utils/logger.js";

const log = Logger.get("PSMF");

interface NalUnit {
  type: number;     // NAL unit type (5 bits)
  data: Uint8Array; // raw NAL bytes WITHOUT start code
}

export interface DecodedFrame {
  bitmap: ImageBitmap;
  pts: number; // microseconds
}

interface AccessUnit {
  nals: NalUnit[];
  isKey: boolean;
}

// ── Byte helpers ────────────────────────────────────────────────────────────

function readU16BE(buf: Uint8Array, off: number): number {
  return (buf[off]! << 8) | buf[off + 1]!;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

// ── PSMF → raw H.264 ES ────────────────────────────────────────────────────

export function extractH264FromPsmf(pmfData: Uint8Array): { esData: Uint8Array; width: number; height: number } {
  const magic = readU32BE(pmfData, 0);
  if (magic !== 0x50534D46) throw new Error(`Not a PSMF file (magic=0x${magic.toString(16)})`);

  const streamOffset = readU32BE(pmfData, 8);
  const streamSize = readU32BE(pmfData, 12);
  const numStreams = readU16BE(pmfData, 0x80);

  let videoStreamId = 0xE0;
  let width = 144, height = 80;
  for (let i = 0; i < numStreams; i++) {
    const base = 0x82 + i * 16;
    const sid = pmfData[base];
    if (sid !== undefined && (sid & 0xF0) === 0xE0) {
      videoStreamId = sid;
      const w = pmfData[base + 12];
      const h = pmfData[base + 13];
      if (w !== undefined && h !== undefined) {
        width = w * 16;
        height = h * 16;
      }
      break;
    }
  }

  const streamEnd = Math.min(streamOffset + streamSize, pmfData.length);
  const chunks: Uint8Array[] = [];
  let pos = streamOffset;

  while (pos < streamEnd - 4) {
    if (pmfData[pos] !== 0 || pmfData[pos + 1] !== 0 || pmfData[pos + 2] !== 1) {
      pos++; continue;
    }
    const sid = pmfData[pos + 3]!;
    pos += 4;

    if (sid === 0xBA) {
      const stuff = pmfData[pos + 9];
      if (stuff !== undefined && pos + 9 < streamEnd) pos += 10 + (stuff & 0x07);
      continue;
    }
    if (sid < 0xBC) continue;
    if (pos + 1 >= streamEnd) break;

    const pesLen = readU16BE(pmfData, pos);
    pos += 2;
    const pesEnd = Math.min(pos + pesLen, streamEnd);

    if (sid !== videoStreamId) { pos = pesEnd; continue; }
    if (pos + 2 >= pesEnd) { pos = pesEnd; continue; }

    const headerDataLen = pmfData[pos + 2]!;
    const esStart = Math.min(pos + 3 + headerDataLen, pesEnd);
    if (esStart < pesEnd) chunks.push(pmfData.subarray(esStart, pesEnd));
    pos = pesEnd;
  }

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const esData = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { esData.set(c, off); off += c.length; }

  return { esData, width, height };
}

// ── NAL unit parsing ────────────────────────────────────────────────────────

export function splitNals(es: Uint8Array): NalUnit[] {
  const nals: NalUnit[] = [];
  let nalStart = -1;
  let i = 0;
  const len = es.length;

  while (i < len - 3) {
    if (es[i] === 0 && es[i + 1] === 0) {
      if (es[i + 2] === 1 || (es[i + 2] === 0 && i + 3 < len && es[i + 3] === 1)) {
        if (nalStart !== -1) {
          const nalData = es.subarray(nalStart, i);
          if (nalData.length > 0) {
            nals.push({ type: nalData[0]! & 0x1F, data: nalData });
          }
        }
        i += (es[i + 2] === 1) ? 3 : 4;
        nalStart = i;
        continue;
      }
    }
    i++;
  }
  if (nalStart !== -1 && nalStart < len) {
    const nalData = es.subarray(nalStart, len);
    if (nalData.length > 0) {
      nals.push({ type: nalData[0]! & 0x1F, data: nalData });
    }
  }

  return nals;
}

/** Alias for splitNals — parses Annex-B byte stream into NAL units. */
export const parseNalUnits = splitNals;

export function groupAccessUnits(nals: NalUnit[]): AccessUnit[] {
  const units: AccessUnit[] = [];
  let current: NalUnit[] = [];
  let isKey = false;

  for (const n of nals) {
    // AUD (9) is the cleanest boundary
    if (n.type === 9) {
      if (current.length > 0) units.push({ nals: current, isKey });
      current = [n];
      isKey = false;
      continue;
    }

    // SPS (7) / PPS (8) usually start a new IDR access unit if AUD is missing
    if (n.type === 7 || n.type === 8) {
      // If we already have a slice in current, push it and start new
      if (current.some(existing => existing.type >= 1 && existing.type <= 5)) {
        units.push({ nals: current, isKey });
        current = [];
        isKey = false;
      }
      isKey = true;
    }

    if (n.type === 5) isKey = true;
    current.push(n);
  }
  if (current.length > 0) units.push({ nals: current, isKey });
  return units;
}

// ── H.264 avcC (extradata) builder ──────────────────────────────────────────

export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps[1];
  const compat  = sps[2];
  const level   = sps[3];
  if (profile === undefined || compat === undefined || level === undefined) {
    throw new Error("Malformed SPS");
  }

  const size = 6 + 2 + sps.length + 1 + 2 + pps.length;
  const buf = new Uint8Array(size);
  let o = 0;
  buf[o++] = 1;           // configurationVersion
  buf[o++] = profile;
  buf[o++] = compat;
  buf[o++] = level;
  buf[o++] = 0xFF;        // lengthSizeMinusOne = 3 (4-byte lengths)
  buf[o++] = 0xE1;        // numOfSequenceParameterSets = 1
  buf[o++] = (sps.length >> 8) & 0xFF;
  buf[o++] = sps.length & 0xFF;
  buf.set(sps, o); o += sps.length;
  buf[o++] = 1;           // numOfPictureParameterSets = 1
  buf[o++] = (pps.length >> 8) & 0xFF;
  buf[o++] = pps.length & 0xFF;
  buf.set(pps, o);
  return buf;
}

export function auToAvcC(nals: NalUnit[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += 4 + n.data.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const n of nals) {
    const len = n.data.length;
    buf[off++] = (len >> 24) & 0xFF;
    buf[off++] = (len >> 16) & 0xFF;
    buf[off++] = (len >> 8) & 0xFF;
    buf[off++] = len & 0xFF;
    buf.set(n.data, off);
    off += len;
  }
  return buf;
}

// ── Decoder ─────────────────────────────────────────────────────────────────

export class PsmfDecoder {
  private sps: NalUnit | null = null;
  private pps: NalUnit | null = null;
  private codecStr: string = "";
  private accessUnits: AccessUnit[] = [];
  frameCount: number = 0;

  onLog: ((msg: string) => void) | null = null;

  async init(pmfData: Uint8Array): Promise<void> {
    const { esData } = extractH264FromPsmf(pmfData);
    const nals = splitNals(esData);

    const sps = nals.find(n => n.type === 7);
    const pps = nals.find(n => n.type === 8);
    if (!sps || !pps) throw new Error(`Missing SPS/PPS (sps=${!!sps}, pps=${!!pps})`);
    this.sps = sps;
    this.pps = pps;

    const p1 = sps.data[1];
    const p2 = sps.data[2];
    const p3 = sps.data[3];
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error("Invalid SPS data");

    this.codecStr = `avc1.${[p1, p2, p3].map(b => b.toString(16).padStart(2, '0')).join('')}`;
    this.accessUnits = groupAccessUnits(nals);
    this.frameCount = this.accessUnits.length;
  }

  async decode(): Promise<DecodedFrame[]> {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("WebCodecs API not available");
    }

    const { sps, pps, codecStr, accessUnits } = this;
    if (!sps || !pps) throw new Error("Not initialized");

    const decodedFrames: DecodedFrame[] = [];
    const bitmapPromises: Promise<void>[] = [];
    const frameDuration = 33333; // ~30fps in microseconds
    let decodeErrors = 0;

    const description = buildAvcC(sps.data, pps.data);
    const config: VideoDecoderConfig = {
      codec: codecStr,
      description,
      hardwareAcceleration: "prefer-software",
    };

    const decoder = new VideoDecoder({
      output(frame: VideoFrame) {
        const pts = frame.timestamp ?? 0;
        const p = createImageBitmap(frame).then(bmp => {
          decodedFrames.push({ bitmap: bmp, pts });
          frame.close();
        }).catch(() => frame.close());
        bitmapPromises.push(p);
      },
      error() {
        decodeErrors++;
      },
    });

    decoder.configure(config);

    const firstKey = accessUnits.findIndex(au => au.isKey);
    if (firstKey < 0) throw new Error("No IDR keyframe found");

    for (let i = firstKey; i < accessUnits.length; i++) {
      const au = accessUnits[i]!;
      const isKey = au.isKey;

      const chunkNals = au.nals.filter(n => n.type >= 1 && n.type <= 8);
      if (chunkNals.length === 0) continue;

      const chunkData = auToAvcC(chunkNals);
      const timestamp = (i - firstKey) * frameDuration;

      if (decoder.state === "closed") break;
      try {
        decoder.decode(new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp,
          duration: frameDuration,
          data: chunkData.buffer as ArrayBuffer,
        }));
      } catch (err) {
        log.error(`Decode error: ${err}`);
        decodeErrors++;
      }
    }

    if (decoder.state !== "closed") {
      try { await decoder.flush(); } catch {}
      try { decoder.close(); } catch {}
    }
    await Promise.all(bitmapPromises);

    if (decodeErrors > 0) {
      this.onLog?.(`Decoded with ${decodeErrors} errors`);
    }

    return decodedFrames.sort((a, b) => a.pts - b.pts);
  }
}
