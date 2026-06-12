/**
 * Streaming MPEG-2 Program Stream demuxer for PSP PSMF video.
 *
 * The default libav.js build has no MPEG-PS demuxer, so we split the stream
 * ourselves and hand H.264 access units to WebCodecs. The PSP feeds the PS
 * incrementally through the sceMpeg ringbuffer, so this parses what it can and
 * keeps the incomplete tail for the next feed.
 *
 * Two stages:
 *  1. PS demux: pull the video elementary stream (NAL bytes) out of the pack/PES
 *     wrapping and remember each PES's PTS by its byte offset in that stream.
 *  2. H.264 framer: split the elementary stream into access units (one picture
 *     each) on real NAL boundaries, NOT on PES/PTS boundaries. A new AU starts
 *     at an access-unit delimiter, at param sets/SEI that follow a finished
 *     picture, or at the first slice of a new picture (first_mb_in_slice == 0).
 *     Splitting on PTS instead packs several pictures into one chunk when a
 *     stream carries fewer PTS than frames, which WebCodecs rejects.
 *
 * Reference: ppsspp-reference/Core/HW/MpegDemux.cpp (PES/pack parsing), and the
 * H.264 spec 7.4.1.2.3-2.4 for access-unit boundary detection.
 */

export interface AccessUnit {
  /** H.264 Annex-B bytes for one picture. */
  data: Uint8Array;
  /** 90kHz presentation timestamp, or -1 if the stream gave none. */
  pts: number;
  /** True if this AU contains an SPS or IDR slice (a decodable start point). */
  keyframe: boolean;
}

const VIDEO_ID_LOW = 0xe0;
const VIDEO_ID_HIGH = 0xef;

export class PsmfDemux {
  // Raw Program Stream tail not yet split into PES units.
  private buf = new Uint8Array(0);
  // Video elementary stream (NAL bytes) not yet emitted as access units.
  private es = new Uint8Array(0);
  // Absolute offset of es[0] within the whole elementary stream.
  private esBaseAbs = 0;
  // PTS markers by absolute elementary-stream offset (where a PES payload began).
  private ptsMarkers: { abs: number; pts: number }[] = [];
  private ready: AccessUnit[] = [];

  /** Append more Program Stream bytes and parse whatever is now complete. */
  feed(bytes: Uint8Array): void {
    this.buf = concat(this.buf, bytes);
    this.parsePs();
    this.frame(false);
  }

  /** Flush the access unit currently being accumulated (call at end of stream). */
  end(): void {
    this.frame(true);
  }

  /** Drain the access units decoded so far. */
  take(): AccessUnit[] {
    const r = this.ready;
    this.ready = [];
    return r;
  }

  /** Pull video payloads out of the PS wrapping into the elementary stream. */
  private parsePs(): void {
    const b = this.buf;
    let i = 0;
    while (i + 4 <= b.length) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) {
        i++; // not at a start code; scan forward
        continue;
      }
      const streamId = b[i + 3]!;

      if (streamId === 0xba) {
        // Pack header. MPEG-2: 14 bytes + stuffing (low 3 bits of byte 13).
        // MPEG-1: 12 bytes.
        const isMpeg2 = (b[i + 4]! & 0xc0) === 0x40;
        let len = isMpeg2 ? 14 : 12;
        if (isMpeg2) {
          if (i + 14 > b.length) break;
          len += b[i + 13]! & 0x07;
        }
        if (i + len > b.length) break;
        i += len;
        continue;
      }

      if (streamId === 0xb9) { // MPEG_program_end_code
        i += 4;
        continue;
      }

      // Everything else (system header 0xBB, PES 0xBD/0xC0-0xEF, padding 0xBE)
      // carries a 2-byte length.
      if (i + 6 > b.length) break;
      const pktLen = (b[i + 4]! << 8) | b[i + 5]!;
      const pktStart = i + 6;
      if (pktStart + pktLen > b.length) break; // incomplete packet; wait for more

      if (streamId >= VIDEO_ID_LOW && streamId <= VIDEO_ID_HIGH) {
        this.handleVideoPes(b.subarray(pktStart, pktStart + pktLen));
      }
      i = pktStart + pktLen;
    }

    this.buf = i > 0 ? b.slice(i) : b;
  }

  private handleVideoPes(pkt: Uint8Array): void {
    // MPEG-2 PES header: '10xxxxxx', flags, header_data_length, then optional
    // PTS/DTS. payload (NAL bytes) follows the optional header.
    let p = 0;
    let pts = -1;
    if (pkt.length >= 3 && (pkt[0]! & 0xc0) === 0x80) {
      const ptsDtsFlags = (pkt[1]! >> 6) & 0x03;
      const headerLen = pkt[2]!;
      const optStart = 3;
      if (ptsDtsFlags & 0x02 && optStart + 5 <= pkt.length) {
        const b0 = pkt[optStart]!, b1 = pkt[optStart + 1]!, b2 = pkt[optStart + 2]!,
          b3 = pkt[optStart + 3]!, b4 = pkt[optStart + 4]!;
        pts = ((b0 >> 1) & 0x07) * 0x40000000 + (b1 << 22) + ((b2 >> 1) << 15) + (b3 << 7) + (b4 >> 1);
      }
      p = 3 + headerLen;
    }
    if (p >= pkt.length) return;
    const payload = pkt.subarray(p);

    if (pts >= 0) {
      this.ptsMarkers.push({ abs: this.esBaseAbs + this.es.length, pts });
    }
    this.es = concat(this.es, payload);
  }

  /**
   * Split the elementary stream into access units on H.264 boundaries. Emits all
   * complete AUs and keeps the last one buffered (we only know an AU is finished
   * when the next one starts). With emitLast, flush the final AU too.
   */
  private frame(emitLast: boolean): void {
    const es = this.es;

    // NAL header byte index for every start code (00 00 01).
    const nalStarts: number[] = [];
    for (let i = 0; i + 3 < es.length; i++) {
      if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) {
        nalStarts.push(i + 3);
        i += 2;
      }
    }
    if (nalStarts.length === 0) return;

    // Byte offset (of the start code) where each new access unit begins.
    const auStartsByte: number[] = [];
    let auHasVcl = false;
    for (let k = 0; k < nalStarts.length; k++) {
      const h = nalStarts[k]!;
      const type = es[h]! & 0x1f;
      const isVcl = type >= 1 && type <= 5;
      let startsAu = false;
      if (k === 0) {
        startsAu = true;
      } else if (isVcl) {
        // first_mb_in_slice == 0 (new picture) shows as the top bit of the first
        // slice-header byte (ue(v) of 0 is a single '1' bit).
        const newPicture = h + 1 < es.length && (es[h + 1]! & 0x80) !== 0;
        if (newPicture && auHasVcl) startsAu = true;
      } else if (type === 9 || type === 7 || type === 8 || type === 6 || (type >= 13 && type <= 15)) {
        // AUD / SPS / PPS / SEI / suffix sets following a finished picture.
        if (auHasVcl) startsAu = true;
      }
      if (startsAu) {
        auStartsByte.push(h - 3);
        auHasVcl = false;
      }
      if (isVcl) auHasVcl = true;
    }

    const count = auStartsByte.length;
    const lastToEmit = emitLast ? count : count - 1;
    for (let j = 0; j < lastToEmit; j++) {
      const byteStart = auStartsByte[j]!;
      const byteEnd = j + 1 < count ? auStartsByte[j + 1]! : es.length;
      const data = es.slice(byteStart, byteEnd);
      if (!hasVclNal(data)) continue; // skip param-set-only tail with no picture
      const absStart = this.esBaseAbs + byteStart;
      const absEnd = this.esBaseAbs + byteEnd;
      let pts = -1;
      for (const m of this.ptsMarkers) {
        if (m.abs >= absStart && m.abs < absEnd) { pts = m.pts; break; }
      }
      this.ready.push({ data, pts, keyframe: hasKeyNal(data) });
    }

    if (emitLast) {
      this.esBaseAbs += es.length;
      this.es = new Uint8Array(0);
      this.ptsMarkers = [];
    } else if (count >= 1) {
      const newStart = auStartsByte[count - 1]!;
      this.es = es.slice(newStart);
      this.esBaseAbs += newStart;
      this.ptsMarkers = this.ptsMarkers.filter((m) => m.abs >= this.esBaseAbs);
    }
  }
}

/** True if the Annex-B payload contains an SPS (NAL 7) or IDR slice (NAL 5). */
function hasKeyNal(data: Uint8Array): boolean {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const nalType = data[i + 3]! & 0x1f;
      if (nalType === 5 || nalType === 7) return true;
    }
  }
  return false;
}

/** True if the Annex-B payload contains a VCL slice NAL (types 1-5). */
function hasVclNal(data: Uint8Array): boolean {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const nalType = data[i + 3]! & 0x1f;
      if (nalType >= 1 && nalType <= 5) return true;
    }
  }
  return false;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Parse an avc1 codec string ("avc1.PPCCLL") from the first SPS NAL in an
 * Annex-B buffer, for VideoDecoder.configure(). Returns null if no SPS is found.
 */
export function avcCodecFromAnnexB(data: Uint8Array): string | null {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const nalType = data[i + 3]! & 0x1f;
      if (nalType === 7 && i + 6 < data.length) {
        const profile = data[i + 4]!, constraints = data[i + 5]!, level = data[i + 6]!;
        const hx = (n: number): string => n.toString(16).padStart(2, "0");
        return `avc1.${hx(profile)}${hx(constraints)}${hx(level)}`;
      }
    }
  }
  return null;
}
