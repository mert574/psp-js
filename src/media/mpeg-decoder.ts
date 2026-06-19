/**
 * Real PSP MPEG (PSMF) video decode via WebCodecs.
 *
 * The default libav.js build ships no H.264 decoder and no MPEG-PS demuxer, so
 * we demux the Program Stream ourselves (PsmfDemux) and decode the H.264 access
 * units with the browser's native VideoDecoder.
 *
 * Pacing matters. Our HLE disc reads are instant, so the game fills the whole
 * sceMpeg ringbuffer in a burst. If we decoded every access unit as it arrived,
 * the decoder would race hundreds of frames ahead of the game and we'd have to
 * drop most of them (only a handful fit in memory). Instead we demux eagerly
 * (compressed AUs are small and cheap to hold) but DECODE lazily: keep only a
 * small lookahead of decoded frames in flight, and decode the next AU each time
 * the game consumes one. So the decoded-frame count tracks sceMpegAvcDecode
 * calls 1:1 instead of dumping the whole clip at once.
 *
 * Browser-only (WebCodecs + OffscreenCanvas). Under Node the caller skips this
 * and uses the placeholder black-frame path. Audio (ATRAC3+) is not handled.
 */

import { PsmfDemux, avcCodecFromAnnexB, type AccessUnit } from "./psmf-demux.js";

export interface DecodedVideoFrame {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
  pts: number;
}

// Decoded frames to keep ready ahead of the game. Big enough to cover H.264
// reorder depth (B-frames) so the decoder never stalls waiting for input, small
// enough that memory stays bounded (each frame is width*height*4 bytes).
const LOOKAHEAD = 16;
// Hard cap in case in-flight accounting ever drifts; pacing keeps us well below.
const MAX_QUEUE = 64;
// Consecutive decoder errors (no decoded frame in between) before we give up for
// good. A looping menu video re-sends a keyframe each loop, so a transient error
// recovers on the next keyframe; only a stream we genuinely can't decode hits this.
const MAX_RESETS = 8;

export class MpegMediaDecoder {
  private demux = new PsmfDemux();
  private decoder: VideoDecoder | null = null;
  private configured = false;
  private firstKeySent = false;
  private failedFlag = false;
  // Demuxed-but-not-yet-decoded access units (compressed, cheap to hold).
  private pendingAus: AccessUnit[] = [];
  // Chunks handed to the decoder that haven't produced a frame yet.
  private inFlight = 0;
  // Consecutive decoder resets without a decoded frame in between (reset on success).
  private resetCount = 0;
  // True once we've logged a recovery this session; keeps the console from
  // filling with one line per dropped frame when a video hiccups every GOP.
  private warnedRecover = false;
  // Strictly-increasing timestamp for decode(). The PSP stream only carries a
  // real PTS about once every 10 frames (the rest are -1), and a long run of
  // equal/-1 timestamps makes WebCodecs fail to order frames and then error.
  // We feed in decode order anyway, so a plain counter is the right ordering key.
  private decodeTs = 0;
  private videoQueue: DecodedVideoFrame[] = [];
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  // SPS+PPS from the stream start. H.264 in PS only sends these once, but
  // WebCodecs needs them before every keyframe, so we cache and re-inject.
  private paramSets: Uint8Array | null = null;

  get failed(): boolean { return this.failedFlag; }
  get queuedFrames(): number { return this.videoQueue.length; }

  /** Append raw Program Stream bytes (what the ringbuffer callback wrote). */
  feed(bytes: Uint8Array): void {
    if (this.failedFlag) return;
    if (typeof VideoDecoder === "undefined") { this.failedFlag = true; return; }
    try {
      this.demux.feed(bytes);
      this.pendingAus.push(...this.demux.take());
      this.pump();
    } catch (e) {
      console.warn("[MPEG] demux/feed error", e);
      this.failedFlag = true;
    }
  }

  /** Signal end of stream so the last access units and frames flush out. */
  end(): void {
    if (this.failedFlag) return;
    try {
      this.demux.end();
      this.pendingAus.push(...this.demux.take());
      this.pump();
      if (this.pendingAus.length === 0) {
        void this.decoder?.flush().catch(() => { /* flush after close is fine */ });
      }
    } catch { /* ignore */ }
  }

  /** Pop the next decoded frame, or null if none ready yet. Decodes one more. */
  takeVideoFrame(): DecodedVideoFrame | null {
    const f = this.videoQueue.shift() ?? null;
    this.pump(); // consuming a frame frees a slot; keep the lookahead full
    return f;
  }

  dispose(): void {
    this.videoQueue = [];
    this.pendingAus = [];
    const dec = this.decoder;
    this.decoder = null;
    this.failedFlag = true;
    try { if (dec && dec.state !== "closed") dec.close(); } catch { /* ignore */ }
  }

  /** Decode pending AUs until the decoded lookahead is full. */
  private pump(): void {
    if (this.failedFlag) return;
    while (this.videoQueue.length + this.inFlight < LOOKAHEAD && this.pendingAus.length > 0) {
      this.tryDecode(this.pendingAus.shift()!);
      if (this.failedFlag) return;
    }
  }

  private ensureDecoder(): boolean {
    if (this.decoder) return true;
    if (typeof VideoDecoder === "undefined") { this.failedFlag = true; return false; }
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => this.recover(e),
    });
    return true;
  }

  /** A decode failure (corrupt AU, a dropped reference, or a delta arriving
   *  before a keyframe) kills the VideoDecoder. Instead of giving up forever,
   *  drop the broken decoder and resync at the next keyframe — a looping video
   *  re-sends one each loop. This runs from BOTH the async error callback and
   *  the synchronous decode() throw: the sync path matters because once the
   *  decoder is bad, decode() rejects every following delta, and without
   *  resetting our flags here we'd hammer it thousands of times before the async
   *  error callback gets a turn. Give up only after MAX_RESETS in a row with no
   *  decoded frame in between (onFrame clears the streak). */
  private recover(reason: unknown): void {
    if (this.failedFlag) return;
    const dec = this.decoder;
    this.decoder = null;
    try { if (dec && dec.state !== "closed") dec.close(); } catch { /* already closed */ }
    this.configured = false;
    this.firstKeySent = false;
    this.inFlight = 0;
    // Drop queued AUs up to the next keyframe; deltas before it can't decode on a
    // fresh decoder. If none is buffered yet, the next feed() brings one.
    const nextKey = this.pendingAus.findIndex((a) => a.keyframe);
    this.pendingAus = nextKey >= 0 ? this.pendingAus.slice(nextKey) : [];
    this.resetCount++;
    if (this.resetCount > MAX_RESETS) {
      this.failedFlag = true;
      console.warn("[MPEG] video decoder failed repeatedly, showing placeholder", reason);
    } else if (!this.warnedRecover) {
      // Log once per session — a looping video that hiccups every GOP would
      // otherwise spam the console with one line per dropped frame.
      this.warnedRecover = true;
      console.warn("[MPEG] video decoder hiccup, resyncing at next keyframe", reason);
    }
  }

  /** Configure on the first SPS, then submit one access unit to the decoder. */
  private tryDecode(au: AccessUnit): void {
    if (!this.paramSets) this.paramSets = extractParamSets(au.data);
    if (!this.configured) {
      // A mid-stream resync keyframe may not carry its own SPS; fall back to the
      // SPS we cached from the stream start so we can still derive the codec.
      const codec = avcCodecFromAnnexB(au.data)
        ?? (this.paramSets ? avcCodecFromAnnexB(this.paramSets) : null);
      if (!codec) return; // wait for an AU that carries the SPS
      if (!this.ensureDecoder()) return;
      // Annex-B input: omit `description`. Low latency so frames come out fast.
      this.decoder!.configure({ codec, optimizeForLatency: true } as VideoDecoderConfig);
      this.configured = true;
    }
    // WebCodecs requires the first chunk to be a keyframe.
    if (!this.firstKeySent) {
      if (!au.keyframe) return;
      this.firstKeySent = true;
    }
    // A keyframe that lacks its own SPS won't decode; prepend the cached set.
    let data = au.data;
    if (au.keyframe && this.paramSets && !containsNalType(au.data, 7)) {
      data = concat(this.paramSets, au.data);
    }
    try {
      this.decoder!.decode(new EncodedVideoChunk({
        type: au.keyframe ? "key" : "delta",
        // Monotonic decode-order timestamp, not au.pts (mostly -1 in this stream).
        timestamp: this.decodeTs++,
        data: data as BufferSource,
      }));
      this.inFlight++;
    } catch (e) {
      // decode() rejects synchronously when the decoder is in a bad state (most
      // often a delta reached it before a keyframe after a prior error). Reset
      // and resync instead of re-throwing on every following delta.
      this.recover(e);
    }
  }

  private onFrame(frame: VideoFrame): void {
    if (this.inFlight > 0) this.inFlight--;
    this.resetCount = 0; // a decoded frame means we recovered; clear the failure streak
    try {
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;
      if (w <= 0 || h <= 0) return;
      if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas = new OffscreenCanvas(w, h);
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      }
      if (!this.ctx) return;
      this.ctx.drawImage(frame, 0, 0);
      const img = this.ctx.getImageData(0, 0, w, h);
      if (this.videoQueue.length < MAX_QUEUE) {
        this.videoQueue.push({ width: w, height: h, rgba: img.data, pts: frame.timestamp });
      }
    } catch (e) {
      console.warn("[MPEG] frame readback error", e);
    } finally {
      frame.close();
    }
  }
}

/** True if the Annex-B buffer contains a NAL of the given type. */
function containsNalType(data: Uint8Array, type: number): boolean {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if ((data[i + 3]! & 0x1f) === type) return true;
    }
  }
  return false;
}

/** Collect the SPS (NAL 7) and PPS (NAL 8) NAL units, with start codes. */
function extractParamSets(data: Uint8Array): Uint8Array | null {
  // Find NAL boundaries (3-byte start codes), keep type 7/8 spans.
  const starts: number[] = [];
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) starts.push(i);
  }
  const parts: Uint8Array[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s]!;
    const end = s + 1 < starts.length ? starts[s + 1]! : data.length;
    const nalType = data[begin + 3]! & 0x1f;
    if (nalType === 7 || nalType === 8) parts.push(data.subarray(begin, end));
  }
  if (parts.length === 0) return null;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
