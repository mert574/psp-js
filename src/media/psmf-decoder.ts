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

export interface NalUnit {
  type: number;     // NAL unit type (5 bits)
  data: Uint8Array; // raw NAL bytes WITHOUT start code
}

export interface DecodedFrame {
  bitmap: ImageBitmap;
  pts: number; // microseconds
}

// ── Byte helpers ────────────────────────────────────────────────────────────

function readU16BE(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
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
    if ((pmfData[base] & 0xF0) === 0xE0) {
      videoStreamId = pmfData[base];
      width = pmfData[base + 12] * 16;
      height = pmfData[base + 13] * 16;
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
    const sid = pmfData[pos + 3];
    pos += 4;

    if (sid === 0xBA) {
      if (pos + 9 < streamEnd) pos += 10 + (pmfData[pos + 9] & 0x07);
      continue;
    }
    if (sid < 0xBC) continue;
    if (pos + 1 >= streamEnd) break;

    const pesLen = readU16BE(pmfData, pos);
    pos += 2;
    const pesEnd = Math.min(pos + pesLen, streamEnd);

    if (sid !== videoStreamId) { pos = pesEnd; continue; }
    if (pos + 2 >= pesEnd) { pos = pesEnd; continue; }

    const headerDataLen = pmfData[pos + 2];
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

/** Split Annex B stream into individual NAL units */
export function parseNalUnits(es: Uint8Array): NalUnit[] {
  const nals: NalUnit[] = [];
  let i = 0;
  const len = es.length;

  // Find first start code
  while (i < len - 3) {
    if (es[i] === 0 && es[i + 1] === 0) {
      if (es[i + 2] === 1) { i += 3; break; }
      if (es[i + 2] === 0 && i + 3 < len && es[i + 3] === 1) { i += 4; break; }
    }
    i++;
  }

  let nalStart = i;
  while (i < len - 3) {
    if (es[i] === 0 && es[i + 1] === 0) {
      if (es[i + 2] === 1 || (es[i + 2] === 0 && i + 3 < len && es[i + 3] === 1)) {
        const nalData = es.subarray(nalStart, i);
        if (nalData.length > 0) {
          nals.push({ type: nalData[0] & 0x1F, data: nalData });
        }
        i += (es[i + 2] === 1) ? 3 : 4;
        nalStart = i;
        continue;
      }
    }
    i++;
  }
  if (nalStart < len) {
    const nalData = es.subarray(nalStart, len);
    if (nalData.length > 0) {
      nals.push({ type: nalData[0] & 0x1F, data: nalData });
    }
  }

  return nals;
}

/** Build avcC (AVCDecoderConfigurationRecord) from SPS and PPS NALs */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps[1];
  const compat = sps[2];
  const level = sps[3];

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
  buf[o++] = 1;           // numOfPictureParameterSets
  buf[o++] = (pps.length >> 8) & 0xFF;
  buf[o++] = pps.length & 0xFF;
  buf.set(pps, o);
  return buf;
}

/** Group NALs into access units (one per frame). Each AU starts at an AUD. */
export function groupAccessUnits(nals: NalUnit[]): { isKey: boolean; nals: NalUnit[] }[] {
  const aus: { isKey: boolean; nals: NalUnit[] }[] = [];
  let current: NalUnit[] = [];

  for (const nal of nals) {
    if (nal.type === 9) {
      if (current.length > 0) {
        const isKey = current.some(n => n.type === 5);
        aus.push({ isKey, nals: current });
      }
      current = [];
      continue;
    }
    current.push(nal);
  }
  if (current.length > 0) {
    const isKey = current.some(n => n.type === 5);
    aus.push({ isKey, nals: current });
  }
  return aus;
}

/** Convert NALs to avcC format (4-byte length prefixed, no start codes) */
export function auToAvcC(nals: NalUnit[]): Uint8Array {
  let totalSize = 0;
  for (const nal of nals) totalSize += 4 + nal.data.length;

  const buf = new Uint8Array(totalSize);
  let off = 0;
  for (const nal of nals) {
    const len = nal.data.length;
    buf[off] = (len >> 24) & 0xFF;
    buf[off + 1] = (len >> 16) & 0xFF;
    buf[off + 2] = (len >> 8) & 0xFF;
    buf[off + 3] = len & 0xFF;
    buf.set(nal.data, off + 4);
    off += 4 + len;
  }
  return buf;
}

// ── PsmfDecoder ─────────────────────────────────────────────────────────────

export class PsmfDecoder {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;

  private readonly codecStr: string;
  private readonly sps: NalUnit;
  private readonly pps: NalUnit;
  private readonly accessUnits: { isKey: boolean; nals: NalUnit[] }[];
  private frames: DecodedFrame[] = [];

  /** Optional log callback for diagnostics */
  onLog?: (msg: string) => void;

  constructor(pmfData: Uint8Array) {
    const { esData, width, height } = extractH264FromPsmf(pmfData);
    this.width = width;
    this.height = height;

    const nals = parseNalUnits(esData);
    const sps = nals.find(n => n.type === 7);
    const pps = nals.find(n => n.type === 8);
    if (!sps || !pps) throw new Error(`Missing SPS/PPS (sps=${!!sps}, pps=${!!pps})`);
    this.sps = sps;
    this.pps = pps;

    this.codecStr = `avc1.${[sps.data[1], sps.data[2], sps.data[3]].map(b => b.toString(16).padStart(2, '0')).join('')}`;
    this.accessUnits = groupAccessUnits(nals);
    this.frameCount = this.accessUnits.length;
  }

  /** Decode all frames. Call once before getFrame(). */
  async decode(): Promise<void> {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("WebCodecs API not available");
    }

    const log = this.onLog ?? (() => {});
    const { sps, pps, codecStr, accessUnits } = this;

    const description = buildAvcC(sps.data, pps.data);
    const config: VideoDecoderConfig = {
      codec: codecStr,
      description,
      hardwareAcceleration: "prefer-software",
    };

    const firstKey = accessUnits.findIndex(au => au.isKey);
    if (firstKey < 0) throw new Error("No IDR keyframe found");

    const decodedFrames: DecodedFrame[] = [];
    const bitmapPromises: Promise<void>[] = [];
    const frameDuration = 33333; // ~30fps in microseconds
    let decodeErrors = 0;

    const decoder = new VideoDecoder({
      output(frame: globalThis.VideoFrame) {
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

    for (let i = firstKey; i < accessUnits.length; i++) {
      const au = accessUnits[i];
      const isKey = au.isKey;

      // Include VCL slices (1-5), SEI (6), SPS (7), and PPS (8) in chunk data
      // Sending SPS/PPS in-band avoids reconfiguration and frame loss at keyframes
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
          data: chunkData,
        }));
      } catch {
        // skip malformed chunks
      }
    }

    if (decoder.state !== "closed") {
      try { await decoder.flush(); } catch {}
      try { decoder.close(); } catch {}
    }
    await Promise.all(bitmapPromises);

    log(`${decodedFrames.length}/${accessUnits.length} frames decoded` + (decodeErrors ? ` (${decodeErrors} errors)` : ''));
    if (decodedFrames.length === 0) throw new Error(`No frames decoded (${decodeErrors} errors, ${accessUnits.length} AUs)`);
    decodedFrames.sort((a, b) => a.pts - b.pts);
    this.frames = decodedFrames;
  }

  /** Get a decoded frame by index (0-based). */
  getFrame(index: number): DecodedFrame | undefined {
    return this.frames[index];
  }

  /** Get all decoded frames. */
  getAllFrames(): readonly DecodedFrame[] {
    return this.frames;
  }

  /** Release all decoded frame resources. */
  close(): void {
    for (const f of this.frames) f.bitmap.close();
    this.frames = [];
  }
}
