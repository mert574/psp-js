/**
 * HLE sceMpeg implementation — PPSSPP sceMpeg.cpp semantics WITHOUT real video
 * decode. Ringbuffer accounting, PSMF header analysis, AU bookkeeping, and the
 * ringbuffer-fill MipsCall are faithful; AvcDecode writes black frames.
 *
 * Audio (AtracDecode) DELIBERATELY DIVERGES from PPSSPP. PPSSPP demuxes one AT3+
 * frame per call inside MediaEngine and decodes it with a stateful AT3+ decoder.
 * We take the easier path for now: accumulate the whole muxed Program Stream the
 * game feeds, reconstruct a PMF (captured PSMF header + payload), and let FFmpeg
 * demux + decode the entire audio track at once, then serve it frame-by-frame.
 * This reuses the proven scePsmfPlayer FFmpeg audio path; a real per-frame
 * demux/decoder (matching PPSSPP) is the eventual correct version.
 *
 * Reference: ppsspp-reference/Core/HLE/sceMpeg.cpp
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import { PSMF } from "./nids.js";
import { drawText, textWidth, GLYPH_H } from "../gpu/text-overlay.js";
import { MpegMediaDecoder } from "../media/mpeg-decoder.js";
import { packRgbaToFrame } from "../media/frame-pack.js";
import { decodePsmfAudioToPcm } from "../audio/atrac-decoder.js";

// Real video decode is browser-only (libav.js/WASM). In Node (tests, headless
// tools) we skip it and keep the placeholder black-frame path.
const CAN_DECODE = typeof window !== "undefined";

const log = Logger.get("HLE-MPEG");

// PPSSPP sceMpeg.cpp constants
const MPEG_MEMSIZE = 0x10000;
const MPEG_AVC_ES_SIZE = 2048;
const MPEG_ATRAC_ES_SIZE = 2112;
const MPEG_ATRAC_ES_OUTPUT_SIZE = 8192;
const MPEG_DATA_ES_BUFFERS = 2;
// Max packets fed to the ringbuffer fill callback per _invokeGeCb call. The
// callback copies ~16k interpreted steps/packet; 8 packets stays well under
// _invokeGeCb's 200k step limit so the copy never gets cut off mid-way.
const MAX_FILL_PACKETS_PER_CALL = 8;
const PSMF_MAGIC = 0x464d5350; // "PSMF" read as LE u32
const VIDEO_TIMESTAMP_STEP = 3003;  // 90000 / 29.97 fps
const AUDIO_TIMESTAMP_STEP = 4180;  // 2048 samples / 44100 Hz * 90000

// Error codes (PPSSPP ErrorCodes.h)
const SCE_MPEG_ERROR_NO_DATA = 0x80618001;
const SCE_MPEG_ERROR_INVALID_VALUE = 0x806101fe;
const SCE_MPEG_ERROR_NO_MEMORY = 0x80610022;
const SCE_MPEG_ERROR_AVC_DECODE_FATAL = 0x80628002;

// SceMpegRingBuffer struct offsets (PPSSPP sceMpeg.h, all LE u32)
const RB_PACKETS = 0x00;
const RB_PACKETS_READ = 0x04;
const RB_PACKETS_WRITE_POS = 0x08;
const RB_PACKETS_AVAIL = 0x0c;
const RB_PACKET_SIZE = 0x10;
const RB_DATA = 0x14;
const RB_CALLBACK_ADDR = 0x18;
const RB_CALLBACK_ARGS = 0x1c;
const RB_DATA_UPPER_BOUND = 0x20;
const RB_MPEG = 0x28;

interface MpegContext {
  mpegAddr: number;
  ringbufferAddr: number;
  defaultFrameWidth: number;
  videoPixelMode: number; // 0=5650 1=5551 2=4444 3=8888
  // From PSMF header analysis
  mpegOffset: number;
  mpegStreamSize: number;
  mpegFirstTimestamp: number;
  mpegLastTimestamp: number;
  frameWidth: number;   // avcDetailFrameWidth
  frameHeight: number;  // avcDetailFrameHeight
  // Fake decode state
  videoFrameCount: number;
  audioFrameCount: number;
  endOfVideoReached: boolean;
  endOfAudioReached: boolean;
  packetsPerVideoFrame: number;
  esBuffers: boolean[];
  streamMap: Map<number, { type: number; num: number; needsReset: boolean }>;
  streamIdGen: number;
  isAnalyzed: boolean;
  // Real decode (browser only); null when running the placeholder path.
  decoder: MpegMediaDecoder | null;
  // YCbCr decode path (sceMpegAvcDecodeYCbCr): the decoded frame is held here
  // between the decode call and the sceMpegAvcCsc call that writes it to the
  // framebuffer. `null` means "decoded but no real frame, draw placeholder".
  pendingFrame?: { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number } | null;
  hasPendingFrame?: boolean;

  // ── Cutscene audio (Option B, intentional divergence from PPSSPP) ──────────
  // Captured PSMF header (first mpegOffset bytes) so we can rebuild a full PMF.
  psmfHeader: Uint8Array | null;
  // The muxed Program Stream the game has fed, accumulated in arrival order.
  audioPsChunks: Uint8Array[];
  audioPsLen: number;
  // Whole-track PCM (interleaved s16 stereo @ 44100) decoded from the PMF so far.
  audioPcm: Int16Array | null;
  audioCursor: number;          // stereo frames already served to the game
  audioDecoding: boolean;       // a decode is in flight (one at a time per ctx)
  audioDecodedFromLen: number;  // audioPsLen the current audioPcm was decoded from
  audioGen: number;             // bumped on flush; a decode from an old gen is dropped
}

/** SceMpegAu: pts/dts stored high-word-first (PPSSPP SceMpegAu::read/write). */
function writeAu(bus: MemoryBus, addr: number, pts: number, dts: number, esBuffer: number, esSize: number): void {
  const wr64 = (off: number, v: number): void => {
    if (v < 0) {
      // -1 (UNKNOWN_TIMESTAMP) → all-ones
      bus.writeU32(addr + off, 0xffffffff);
      bus.writeU32(addr + off + 4, 0xffffffff);
    } else {
      bus.writeU32(addr + off, Math.floor(v / 0x100000000));
      bus.writeU32(addr + off + 4, v >>> 0);
    }
  };
  wr64(0, pts);
  wr64(8, dts);
  bus.writeU32(addr + 16, esBuffer);
  bus.writeU32(addr + 20, esSize);
}

function readAuEs(bus: MemoryBus, addr: number): { esBuffer: number; esSize: number } {
  return { esBuffer: bus.readU32(addr + 16), esSize: bus.readU32(addr + 20) };
}

export function registerMpegHLE(kernel: HLEKernel): void {
  const contexts = new Map<number, MpegContext>();

  // PPSSPP getMpegCtx: the address the game holds (mpegAddr) stores a pointer to
  // the real handle struct (dataPtr+0x30, written in sceMpegCreate). Read that
  // pointer and look the context up by it.
  function getCtx(mpegAddr: number): MpegContext | undefined {
    return contexts.get(kernel.bus.readU32(mpegAddr >>> 0) >>> 0);
  }

  /** AnalyzeMpeg (PPSSPP sceMpeg.cpp:259): parse the 2048-byte PSMF header. */
  function analyze(bus: MemoryBus, bufferAddr: number, ctx: MpegContext): boolean {
    const magic = bus.readU32(bufferAddr);
    if (magic !== PSMF_MAGIC) return false;
    const bswap = (v: number): number =>
      (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
    ctx.mpegOffset = bswap(bus.readU32(bufferAddr + 0x8));
    ctx.mpegStreamSize = bswap(bus.readU32(bufferAddr + 0xc));
    // Timestamps are 6-byte big-endian at 0x54 (first) and 0x5A (last)
    const ts48 = (off: number): number => {
      let v = 0;
      for (let i = 0; i < 6; i++) v = v * 256 + bus.readU8(bufferAddr + off + i);
      return v;
    };
    ctx.mpegFirstTimestamp = ts48(0x54);
    ctx.mpegLastTimestamp = ts48(0x5a);
    ctx.frameWidth = bus.readU8(bufferAddr + 142) * 0x10;
    ctx.frameHeight = bus.readU8(bufferAddr + 143) * 0x10;
    // Average packets consumed per video frame so the ringbuffer drains at
    // roughly the real stream rate (we have no demuxer).
    const totalFrames = Math.max(1, Math.round((ctx.mpegLastTimestamp - ctx.mpegFirstTimestamp) / VIDEO_TIMESTAMP_STEP));
    ctx.packetsPerVideoFrame = Math.max(1, Math.round(ctx.mpegStreamSize / 2048 / totalFrames));
    // Keep the PSMF header so the audio path can rebuild a full PMF for FFmpeg
    // (the raw ring payload alone doesn't say the private stream is AT3+).
    if (CAN_DECODE && ctx.mpegOffset > 0 && ctx.mpegOffset <= 0x10000) {
      ctx.psmfHeader = bus.readBytes(bufferAddr, ctx.mpegOffset).slice();
    }
    ctx.isAnalyzed = true;
    log.info(`AnalyzeMpeg: offset=0x${ctx.mpegOffset.toString(16)} size=0x${ctx.mpegStreamSize.toString(16)} ` +
      `ts=${ctx.mpegFirstTimestamp}..${ctx.mpegLastTimestamp} ${ctx.frameWidth}x${ctx.frameHeight} pkts/frame=${ctx.packetsPerVideoFrame}`);
    return true;
  }

  // Re-decode after ~64 new packets so we don't re-run FFmpeg on the whole
  // growing accumulation every frame (it's O(n^2) over the stream).
  const AUDIO_REDECODE_BYTES = 64 * 2048;

  /** Lazily (re)decode the accumulated Program Stream's audio track to PCM.
   *  One decode in flight per context; throttled by how much new data arrived;
   *  keeps the largest result. See the MpegContext audio note for the design. */
  function ensureAudioDecode(ctx: MpegContext): void {
    if (!CAN_DECODE || ctx.audioDecoding || !ctx.psmfHeader || ctx.audioPsLen === 0) return;
    if (ctx.audioPcm && (ctx.audioPsLen - ctx.audioDecodedFromLen) < AUDIO_REDECODE_BYTES) return;
    const fromLen = ctx.audioPsLen;
    const gen = ctx.audioGen;
    const pmf = new Uint8Array(ctx.psmfHeader.length + fromLen);
    pmf.set(ctx.psmfHeader, 0);
    let off = ctx.psmfHeader.length;
    for (const c of ctx.audioPsChunks) { pmf.set(c, off); off += c.length; }
    ctx.audioDecoding = true;
    decodePsmfAudioToPcm(pmf).then((pcm) => {
      ctx.audioDecoding = false;
      if (ctx.audioGen !== gen) return; // a flush replaced the stream; drop stale PCM
      if (pcm.length === 0) { log.debug(`sceMpeg: cutscene audio decode produced no PCM (psLen=${fromLen})`); return; }
      if (!ctx.audioPcm) log.info(`sceMpeg: cutscene audio decoded ${(pcm.length / 2) | 0} frames from ${fromLen} PS bytes`);
      if (pcm.length >= (ctx.audioPcm?.length ?? 0)) {
        ctx.audioPcm = pcm;
        ctx.audioDecodedFromLen = fromLen;
      }
    }).catch(() => { ctx.audioDecoding = false; });
  }

  // sceMpegInit() — PPSSPP returns 0 after delay
  kernel.register(PSMF.sceMpegInit, (regs) => { regs.setGpr(2, 0); });
  kernel.register(PSMF.sceMpegFinish, (regs) => { regs.setGpr(2, 0); });

  // sceMpegQueryMemSize(mode)
  kernel.register(PSMF.sceMpegQueryMemSize, (regs) => { regs.setGpr(2, MPEG_MEMSIZE); });

  // sceMpegRingbufferQueryMemSize(packets) = packets * (104 + 2048)
  kernel.register(PSMF.sceMpegRingbufferQueryMemSize, (regs) => {
    regs.setGpr(2, (regs.getGpr(4) | 0) * (104 + 2048));
  });

  // sceMpegRingbufferConstruct(rbAddr, numPackets, data, size, cbAddr, cbArg)
  kernel.register(PSMF.sceMpegRingbufferConstruct, (regs, bus) => {
    const rbAddr = regs.getGpr(4) >>> 0;
    const numPackets = regs.getGpr(5) | 0;
    const data = regs.getGpr(6) >>> 0;
    const size = regs.getGpr(7) | 0;
    const cbAddr = regs.getGpr(8) >>> 0;  // 5th arg in $t0
    const cbArg = regs.getGpr(9) >>> 0;   // 6th arg in $t1
    if (size < 0) { regs.setGpr(2, SCE_MPEG_ERROR_NO_MEMORY); return; }
    bus.writeU32(rbAddr + RB_PACKETS, numPackets);
    bus.writeU32(rbAddr + RB_PACKETS_READ, 0);
    bus.writeU32(rbAddr + RB_PACKETS_WRITE_POS, 0);
    bus.writeU32(rbAddr + RB_PACKETS_AVAIL, 0);
    bus.writeU32(rbAddr + RB_PACKET_SIZE, 2048);
    bus.writeU32(rbAddr + RB_DATA, data);
    bus.writeU32(rbAddr + RB_CALLBACK_ADDR, cbAddr);
    bus.writeU32(rbAddr + RB_CALLBACK_ARGS, cbArg);
    bus.writeU32(rbAddr + RB_DATA_UPPER_BOUND, data + numPackets * 2048);
    bus.writeU32(rbAddr + RB_MPEG, 0);
    log.info(`sceMpegRingbufferConstruct: rb=0x${rbAddr.toString(16)} packets=${numPackets} data=0x${data.toString(16)} cb=0x${cbAddr.toString(16)}`);
    regs.setGpr(2, 0);
  });

  kernel.register(PSMF.sceMpegRingbufferDestruct, (regs) => { regs.setGpr(2, 0); });

  // sceMpegCreate(mpeg, data, size, rbAddr, frameWidth, mode, ddrtop)
  kernel.register(PSMF.sceMpegCreate, (regs, bus) => {
    const mpegAddr = regs.getGpr(4) >>> 0;
    const dataPtr = regs.getGpr(5) >>> 0;
    const size = regs.getGpr(6) | 0;
    const rbAddr = regs.getGpr(7) >>> 0;
    const frameWidth = regs.getGpr(8) | 0; // $t0
    if (size < MPEG_MEMSIZE) { regs.setGpr(2, SCE_MPEG_ERROR_NO_MEMORY); return; }
    // PPSSPP sceMpeg.cpp:491 — the fake mpeg handle struct lives inside the work
    // buffer at dataPtr+0x30; mpegAddr only holds a pointer to it. Writing the
    // markers AT mpegAddr (as we used to) clobbers whatever follows it: burnout
    // places its ringbuffer struct 12 bytes after mpegAddr, so the old code
    // overwrote packets/packetsRead/packetsWritePos and AvailableSize returned -1.
    const mpegHandle = (dataPtr + 0x30) >>> 0;
    if (rbAddr !== 0) {
      // PPSSPP sceMpeg.cpp:482-487: recompute packetsAvail, then store mpegAddr.
      const packetSize = bus.readU32(rbAddr + RB_PACKET_SIZE) | 0;
      if (packetSize === 0) {
        bus.writeU32(rbAddr + RB_PACKETS_AVAIL, 0);
      } else {
        const packets = bus.readU32(rbAddr + RB_PACKETS) | 0;
        const data = bus.readU32(rbAddr + RB_DATA) >>> 0;
        const upper = bus.readU32(rbAddr + RB_DATA_UPPER_BOUND) >>> 0;
        bus.writeU32(rbAddr + RB_PACKETS_AVAIL, packets - Math.floor((upper - data) / packetSize));
      }
      bus.writeU32(rbAddr + RB_MPEG, mpegAddr);
    }
    // Store the handle pointer at mpegAddr, then write the markers into the buffer.
    bus.writeU32(mpegAddr, mpegHandle);
    const magic = "LIBMPEG\x00001\x00";
    for (let i = 0; i < 12; i++) bus.writeU8(mpegHandle + i, magic.charCodeAt(i));
    bus.writeU32(mpegHandle + 12, 0xffffffff);
    if (rbAddr !== 0) {
      bus.writeU32(mpegHandle + 16, rbAddr);
      bus.writeU32(mpegHandle + 20, bus.readU32(rbAddr + RB_DATA_UPPER_BOUND));
    }
    contexts.set(mpegHandle, {
      mpegAddr,
      ringbufferAddr: rbAddr,
      defaultFrameWidth: frameWidth,
      videoPixelMode: 3,
      mpegOffset: 0, mpegStreamSize: 0,
      mpegFirstTimestamp: 90000, mpegLastTimestamp: 0,
      frameWidth: 480, frameHeight: 272,
      videoFrameCount: 0, audioFrameCount: 0,
      endOfVideoReached: false, endOfAudioReached: false,
      packetsPerVideoFrame: 4,
      esBuffers: new Array(MPEG_DATA_ES_BUFFERS).fill(false),
      streamMap: new Map(),
      streamIdGen: 1,
      isAnalyzed: false,
      decoder: CAN_DECODE ? new MpegMediaDecoder() : null,
      psmfHeader: null,
      audioPsChunks: [], audioPsLen: 0,
      audioPcm: null, audioCursor: 0, audioDecoding: false, audioDecodedFromLen: 0, audioGen: 0,
    });
    log.info(`sceMpegCreate: mpeg=0x${mpegAddr.toString(16)} handle=0x${mpegHandle.toString(16)} rb=0x${rbAddr.toString(16)} frameWidth=${frameWidth}`);
    regs.setGpr(2, 0);
  });

  kernel.register(PSMF.sceMpegDelete, (regs, bus) => {
    const handle = bus.readU32(regs.getGpr(4) >>> 0) >>> 0;
    contexts.get(handle)?.decoder?.dispose();
    contexts.delete(handle);
    regs.setGpr(2, 0);
  });

  // sceMpegRegistStream(mpeg, streamType, streamNum) → stream id
  kernel.register(PSMF.sceMpegRegistStream, (regs) => {
    const ctx = getCtx(regs.getGpr(4));
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    const sid = ctx.streamIdGen++;
    ctx.streamMap.set(sid, { type: regs.getGpr(5), num: regs.getGpr(6), needsReset: true });
    regs.setGpr(2, sid);
  });
  kernel.register(PSMF.sceMpegUnRegistStream, (regs) => {
    const ctx = getCtx(regs.getGpr(4));
    ctx?.streamMap.delete(regs.getGpr(5));
    regs.setGpr(2, 0);
  });

  // sceMpegMallocAvcEsBuf(mpeg) → 1..2, 0 when none free
  kernel.register(PSMF.sceMpegMallocAvcEsBuf, (regs) => {
    const ctx = getCtx(regs.getGpr(4));
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    for (let i = 0; i < MPEG_DATA_ES_BUFFERS; i++) {
      if (!ctx.esBuffers[i]) { ctx.esBuffers[i] = true; regs.setGpr(2, i + 1); return; }
    }
    regs.setGpr(2, 0);
  });
  kernel.register(PSMF.sceMpegFreeAvcEsBuf, (regs) => {
    const ctx = getCtx(regs.getGpr(4));
    const id = regs.getGpr(5) | 0;
    if (ctx && id >= 1 && id <= MPEG_DATA_ES_BUFFERS) ctx.esBuffers[id - 1] = false;
    regs.setGpr(2, 0);
  });

  // sceMpegInitAu(mpeg, bufferAddr, auPointer) — PPSSPP sceMpeg.cpp:1319
  kernel.register(PSMF.sceMpegInitAu, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const bufferAddr = regs.getGpr(5) >>> 0;
    const auAddr = regs.getGpr(6) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    if (bufferAddr >= 1 && bufferAddr <= MPEG_DATA_ES_BUFFERS && ctx.esBuffers[bufferAddr - 1]) {
      writeAu(bus, auAddr, 0, 0, 0, MPEG_AVC_ES_SIZE);
    } else {
      writeAu(bus, auAddr, 0, -1, 0, MPEG_ATRAC_ES_SIZE);
    }
    regs.setGpr(2, 0);
  });

  // sceMpegQueryAtracEsSize(mpeg, esSizeAddr, outSizeAddr)
  kernel.register(PSMF.sceMpegQueryAtracEsSize, (regs, bus) => {
    const esSizeAddr = regs.getGpr(5) >>> 0;
    const outSizeAddr = regs.getGpr(6) >>> 0;
    if (esSizeAddr) bus.writeU32(esSizeAddr, MPEG_ATRAC_ES_SIZE);
    if (outSizeAddr) bus.writeU32(outSizeAddr, MPEG_ATRAC_ES_OUTPUT_SIZE);
    regs.setGpr(2, 0);
  });
  kernel.register(PSMF.sceMpegQueryPcmEsSize, (regs, bus) => {
    const esSizeAddr = regs.getGpr(5) >>> 0;
    const outSizeAddr = regs.getGpr(6) >>> 0;
    if (esSizeAddr) bus.writeU32(esSizeAddr, 320);
    if (outSizeAddr) bus.writeU32(outSizeAddr, 320);
    regs.setGpr(2, 0);
  });

  // sceMpegQueryStreamOffset(mpeg, bufferAddr, offsetAddr)
  kernel.register(PSMF.sceMpegQueryStreamOffset, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const bufferAddr = regs.getGpr(5) >>> 0;
    const offsetAddr = regs.getGpr(6) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    if (!analyze(bus, bufferAddr, ctx) || (ctx.mpegOffset & 2047) !== 0 || ctx.mpegOffset === 0) {
      if (offsetAddr) bus.writeU32(offsetAddr, 0);
      regs.setGpr(2, SCE_MPEG_ERROR_INVALID_VALUE);
      return;
    }
    if (offsetAddr) bus.writeU32(offsetAddr, ctx.mpegOffset);
    regs.setGpr(2, 0);
  });

  // sceMpegQueryStreamSize(bufferAddr, sizeAddr) — no mpeg handle!
  kernel.register(PSMF.sceMpegQueryStreamSize, (regs, bus) => {
    const bufferAddr = regs.getGpr(4) >>> 0;
    const sizeAddr = regs.getGpr(5) >>> 0;
    const magic = bus.readU32(bufferAddr);
    if (magic !== PSMF_MAGIC) {
      if (sizeAddr) bus.writeU32(sizeAddr, 0);
      regs.setGpr(2, SCE_MPEG_ERROR_INVALID_VALUE);
      return;
    }
    const bswap = (v: number): number =>
      (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
    if (sizeAddr) bus.writeU32(sizeAddr, bswap(bus.readU32(bufferAddr + 0xc)));
    regs.setGpr(2, 0);
  });

  // sceMpegRingbufferAvailableSize(rbAddr) = packets - packetsAvail
  kernel.register(PSMF.sceMpegRingbufferAvailableSize, (regs, bus) => {
    const rbAddr = regs.getGpr(4) >>> 0;
    const packets = bus.readU32(rbAddr + RB_PACKETS) | 0;
    const avail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    regs.setGpr(2, packets - avail);
  });

  // sceMpegRingbufferPut(rbAddr, numPackets, available)
  // Calls the game's fill callback cb(dataPtr, numPackets, cbArg) via mini-CPU
  // call; the callback reads packets from disc and returns how many it wrote.
  kernel.register(PSMF.sceMpegRingbufferPut, (regs, bus) => {
    const rbAddr = regs.getGpr(4) >>> 0;
    let numPackets = regs.getGpr(5) | 0;
    const available = regs.getGpr(6) | 0;
    const packets = bus.readU32(rbAddr + RB_PACKETS) | 0;
    const packetsAvail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    const cbAddr = bus.readU32(rbAddr + RB_CALLBACK_ADDR) >>> 0;
    const cbArg = bus.readU32(rbAddr + RB_CALLBACK_ARGS) >>> 0;
    const data = bus.readU32(rbAddr + RB_DATA) >>> 0;

    numPackets = Math.min(numPackets, available, packets - packetsAvail);
    if (numPackets <= 0) { regs.setGpr(2, 0); return; }
    if (cbAddr === 0) { log.warn("sceMpegRingbufferPut: callback_addr zero"); regs.setGpr(2, 0); return; }

    let totalAdded = 0;
    let firstError = 0;
    let writeOffset = (bus.readU32(rbAddr + RB_PACKETS_WRITE_POS) | 0) % packets;
    while (numPackets > 0) {
      // The fill callback copies its packets byte-by-byte in interpreted MIPS
      // (~16k steps/packet). Asking for a whole 256-packet ring at once blows
      // past _invokeGeCb's step limit, so the callback gets cut off mid-copy and
      // returns garbage in $v0. Cap each call to a chunk that finishes well under
      // the limit; the callback tracks its own file position, so looping over
      // small chunks reads the same data (PPSSPP's useRingbufferPutCallbackMulti).
      const packetsThisRound = Math.min(numPackets, packets - writeOffset, MAX_FILL_PACKETS_PER_CALL);
      kernel._invokeGeCb(cbAddr, (data + writeOffset * 2048) >>> 0, packetsThisRound, cbArg);
      // Clamp: the callback can't have added more than we asked for. Guards a
      // truncated/garbage return from corrupting the ring or overrunning readBytes.
      let added = kernel.lastGuestCallReturnValue | 0;
      if (added > packetsThisRound) added = packetsThisRound;
      if (added > 0) {
        const rbRead = bus.readU32(rbAddr + RB_PACKETS_READ) | 0;
        const rbWrite = bus.readU32(rbAddr + RB_PACKETS_WRITE_POS) | 0;
        const rbAvail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
        bus.writeU32(rbAddr + RB_PACKETS_READ, rbRead + added);
        bus.writeU32(rbAddr + RB_PACKETS_WRITE_POS, rbWrite + added);
        bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.min(packets, rbAvail + added));
        totalAdded += added;
        // Feed the freshly written Program Stream bytes to the video decoder and
        // accumulate them for the audio path (see the MpegContext audio note).
        const ctx = getCtx(bus.readU32(rbAddr + RB_MPEG) >>> 0);
        if (ctx) {
          const psBytes = bus.readBytes((data + writeOffset * 2048) >>> 0, added * 2048);
          ctx.decoder?.feed(psBytes);
          if (CAN_DECODE && ctx.psmfHeader) {
            ctx.audioPsChunks.push(psBytes.slice());
            ctx.audioPsLen += psBytes.length;
          }
        }
      } else if (added < 0 && firstError === 0) {
        firstError = added;
      }
      if (added < packetsThisRound) break; // callback couldn't deliver (EOF or error)
      numPackets -= packetsThisRound;
      writeOffset = (writeOffset + packetsThisRound) % packets;
    }
    regs.setGpr(2, totalAdded === 0 && firstError < 0 ? firstError >>> 0 : totalAdded);
  });

  // sceMpegGetAvcAu(mpeg, streamId, auAddr, attrAddr)
  kernel.register(PSMF.sceMpegGetAvcAu, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const streamId = regs.getGpr(5) | 0;
    const auAddr = regs.getGpr(6) >>> 0;
    const attrAddr = regs.getGpr(7) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    const rbAddr = ctx.ringbufferAddr;
    const packetsRead = bus.readU32(rbAddr + RB_PACKETS_READ) | 0;
    const packetsAvail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;

    const pts = ctx.mpegFirstTimestamp + ctx.videoFrameCount * VIDEO_TIMESTAMP_STEP;
    if (ctx.mpegLastTimestamp > 0 && pts > ctx.mpegLastTimestamp) ctx.endOfVideoReached = true;

    if (packetsRead === 0 || packetsAvail === 0 || ctx.endOfVideoReached) {
      writeAu(bus, auAddr, -1, -1, 0, MPEG_AVC_ES_SIZE);
      regs.setGpr(2, SCE_MPEG_ERROR_NO_DATA);
      return;
    }
    const stream = ctx.streamMap.get(streamId);
    if (stream?.needsReset) stream.needsReset = false;
    writeAu(bus, auAddr, pts, pts - VIDEO_TIMESTAMP_STEP, stream?.num ?? 0, MPEG_AVC_ES_SIZE);
    if (attrAddr) bus.writeU32(attrAddr, 1); // PPSSPP: attr = 1 (key frame info)
    regs.setGpr(2, 0);
  });

  // sceMpegGetAtracAu(mpeg, streamId, auAddr, attrAddr)
  kernel.register(PSMF.sceMpegGetAtracAu, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const streamId = regs.getGpr(5) | 0;
    const auAddr = regs.getGpr(6) >>> 0;
    const attrAddr = regs.getGpr(7) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    const rbAddr = ctx.ringbufferAddr;
    const packetsAvail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;

    const pts = ctx.mpegFirstTimestamp + ctx.audioFrameCount * AUDIO_TIMESTAMP_STEP;
    if (ctx.mpegLastTimestamp > 0 && pts > ctx.mpegLastTimestamp) ctx.endOfAudioReached = true;

    if (packetsAvail === 0 || ctx.endOfAudioReached) {
      writeAu(bus, auAddr, -1, -1, 0, MPEG_ATRAC_ES_SIZE);
      regs.setGpr(2, SCE_MPEG_ERROR_NO_DATA);
      return;
    }
    const stream = ctx.streamMap.get(streamId);
    if (stream?.needsReset) stream.needsReset = false;
    writeAu(bus, auAddr, pts, -1, stream?.num ?? 0, MPEG_ATRAC_ES_SIZE);
    if (attrAddr) bus.writeU32(attrAddr, 0);
    regs.setGpr(2, 0);
  });

  // Write a decoded frame (or the black+label placeholder) into the framebuffer
  // at `dest`, optionally offset to (rx,ry) within a `frameWidth`-stride buffer.
  function drawVideoFrame(
    bus: MemoryBus, ctx: MpegContext, dest: number, frameWidth: number,
    realFrame: { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number } | null,
    rx = 0, ry = 0,
  ): void {
    if (dest === 0) return;
    const h = ctx.frameHeight || 272;
    const w = Math.min(frameWidth, ctx.frameWidth || frameWidth);
    const bpp = ctx.videoPixelMode === 3 ? 4 : 2;
    const base = (dest + (ry * frameWidth + rx) * bpp) >>> 0;
    if (realFrame) {
      packRgbaToFrame(bus, base, frameWidth, h, ctx.videoPixelMode,
        realFrame.rgba, realFrame.width, realFrame.height);
      return;
    }
    // Placeholder: black fill + the video name/frame counter overlay.
    if (ctx.videoPixelMode === 3) {
      for (let y = 0; y < h; y++) {
        const row = base + y * frameWidth * 4;
        for (let x = 0; x < w; x++) bus.writeU32(row + x * 4, 0xff000000);
      }
    } else {
      const black = ctx.videoPixelMode === 1 ? 0x8000 : ctx.videoPixelMode === 2 ? 0xf000 : 0x0000;
      for (let y = 0; y < h; y++) {
        const row = base + y * frameWidth * 2;
        for (let x = 0; x < w; x++) bus.writeU16(row + x * 2, black);
      }
    }
    const name = kernel.lastVideoPath ?? "MPEG VIDEO";
    const total = Math.max(1, Math.round((ctx.mpegLastTimestamp - ctx.mpegFirstTimestamp) / VIDEO_TIMESTAMP_STEP));
    const info = `${ctx.frameWidth}X${ctx.frameHeight}  ${ctx.videoFrameCount}/${total}`;
    const scale = 2;
    const ty = Math.max(0, (h >> 1) - GLYPH_H * scale);
    drawText(bus, base, frameWidth, h, ctx.videoPixelMode,
      Math.max(0, (w - textWidth(name, scale)) >> 1), ty, name, scale);
    drawText(bus, base, frameWidth, h, ctx.videoPixelMode,
      Math.max(0, (w - textWidth(info, scale)) >> 1), ty + GLYPH_H * scale + scale * 2, info, scale, [160, 160, 160, 255]);
  }

  // Advance one video frame: consume packets, pull a decoded frame from the
  // real decoder (browser) or null (headless), advance count + AU pts. Returns
  // the frame to draw, or false if there's no data (caller returns FATAL).
  function stepVideo(bus: MemoryBus, ctx: MpegContext, auAddr: number):
    { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number } | null | false {
    const rbAddr = ctx.ringbufferAddr;
    const packetsRead = bus.readU32(rbAddr + RB_PACKETS_READ) | 0;
    if (packetsRead === 0 || ctx.endOfVideoReached) return false;
    const avail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.max(0, avail - ctx.packetsPerVideoFrame));
    const frame = ctx.decoder?.takeVideoFrame() ?? null;
    ctx.videoFrameCount++;
    const { esBuffer } = readAuEs(bus, auAddr);
    const pts = ctx.mpegFirstTimestamp + (ctx.videoFrameCount - 1) * VIDEO_TIMESTAMP_STEP;
    writeAu(bus, auAddr, pts, pts - VIDEO_TIMESTAMP_STEP, esBuffer, MPEG_AVC_ES_SIZE);
    return frame;
  }

  // sceMpegAvcDecode(mpeg, auAddr, frameWidth, bufferAddr, initAddr)
  kernel.register(PSMF.sceMpegAvcDecode, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const auAddr = regs.getGpr(5) >>> 0;
    let frameWidth = regs.getGpr(6) | 0;
    const bufferAddr = regs.getGpr(7) >>> 0;
    const initAddr = regs.getGpr(8) >>> 0;  // 5th arg in $t0
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    if (frameWidth === 0) frameWidth = ctx.defaultFrameWidth || ctx.frameWidth;

    const frame = stepVideo(bus, ctx, auAddr);
    if (frame === false) { regs.setGpr(2, SCE_MPEG_ERROR_AVC_DECODE_FATAL); return; }

    drawVideoFrame(bus, ctx, bus.readU32(bufferAddr) >>> 0, frameWidth, frame);
    if (initAddr) bus.writeU32(initAddr, 1); // avcDecodeResult = MPEG_AVC_DECODE_SUCCESS
    regs.setGpr(2, 0);
  });

  // sceMpegAvcDecodeYCbCr(mpeg, auAddr, bufferAddr, initAddr) — PPSSPP sceMpeg.cpp:1240
  // Decodes one frame but does NOT draw; the frame is written to the framebuffer
  // later by sceMpegAvcCsc. Burnout Legends uses this path instead of AvcDecode.
  kernel.register(PSMF.sceMpegAvcDecodeYCbCr, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const auAddr = regs.getGpr(5) >>> 0;
    const initAddr = regs.getGpr(7) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }

    const frame = stepVideo(bus, ctx, auAddr);
    if (frame === false) { regs.setGpr(2, SCE_MPEG_ERROR_AVC_DECODE_FATAL); return; }

    ctx.pendingFrame = frame;
    ctx.hasPendingFrame = true;
    if (initAddr) bus.writeU32(initAddr, 1); // avcFrameStatus = 1 (frame ready)
    regs.setGpr(2, 0);
  });

  // sceMpegAvcCsc(mpeg, sourceAddr, rangeAddr, frameWidth, destAddr) — sceMpeg.cpp:1884
  // Color-space-converts the frame decoded by sceMpegAvcDecodeYCbCr into destAddr
  // at the (x,y,w,h) rectangle from rangeAddr.
  kernel.register(PSMF.sceMpegAvcCsc, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const rangeAddr = regs.getGpr(6) >>> 0;
    let frameWidth = regs.getGpr(7) | 0;
    const destAddr = regs.getGpr(8) >>> 0; // 5th arg in $t0
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    if (frameWidth === 0) frameWidth = ctx.defaultFrameWidth || ctx.frameWidth;
    const rx = rangeAddr ? bus.readU32(rangeAddr) | 0 : 0;
    const ry = rangeAddr ? bus.readU32(rangeAddr + 4) | 0 : 0;
    if (rx < 0 || ry < 0) { regs.setGpr(2, SCE_MPEG_ERROR_INVALID_VALUE); return; }
    drawVideoFrame(bus, ctx, destAddr, frameWidth, ctx.pendingFrame ?? null, rx, ry);
    ctx.hasPendingFrame = false;
    regs.setGpr(2, 0);
  });

  // sceMpegAvcQueryYCbCrSize(mpeg, mode, width, height, resultAddr) — sceMpeg.cpp
  // Returns the YCbCr work-buffer size the game must allocate.
  kernel.register(PSMF.sceMpegAvcQueryYCbCrSize, (regs, bus) => {
    const width = regs.getGpr(6) | 0;
    const height = regs.getGpr(7) | 0;
    const resultAddr = regs.getGpr(8) >>> 0; // 5th arg in $t0
    if ((width & 15) !== 0 || (height & 15) !== 0 || height > 272 || width > 480) {
      regs.setGpr(2, SCE_MPEG_ERROR_INVALID_VALUE);
      return;
    }
    const size = (width / 2) * (height / 2) * 6 + 128;
    if (resultAddr) bus.writeU32(resultAddr, size);
    regs.setGpr(2, 0);
  });

  // sceMpegAvcInitYCbCr(mpeg, mode, width, height, ycbcr_addr) — returns 0
  kernel.register(PSMF.sceMpegAvcInitYCbCr, (regs) => { regs.setGpr(2, 0); });

  // sceMpegAvcDecodeStop(mpeg, frameWidth, bufferAddr, statusAddr)
  kernel.register(PSMF.sceMpegAvcDecodeStop, (regs, bus) => {
    const statusAddr = regs.getGpr(7) >>> 0;
    if (statusAddr) bus.writeU32(statusAddr, 0);
    regs.setGpr(2, 0);
  });

  // sceMpegAvcDecodeDetail(mpeg, detailAddr)
  kernel.register(PSMF.sceMpegAvcDecodeDetail, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const detailAddr = regs.getGpr(5) >>> 0;
    if (!ctx || !detailAddr) { regs.setGpr(2, 0); return; }
    bus.writeU32(detailAddr + 0, 0);                    // avcDecodeResult
    bus.writeU32(detailAddr + 4, ctx.videoFrameCount);  // videoFrameCount
    bus.writeU32(detailAddr + 8, ctx.frameWidth);       // avcDetailFrameWidth
    bus.writeU32(detailAddr + 12, ctx.frameHeight);     // avcDetailFrameHeight
    bus.writeU32(detailAddr + 16, 0);
    bus.writeU32(detailAddr + 20, 0);
    bus.writeU32(detailAddr + 24, 0);
    bus.writeU32(detailAddr + 28, 0);
    bus.writeU32(detailAddr + 32, ctx.videoFrameCount > 0 ? 1 : 0); // avcFrameStatus
    regs.setGpr(2, 0);
  });

  // sceMpegAvcDecodeMode(mpeg, modeAddr) — modeAddr points at {unk, pixelMode}
  kernel.register(PSMF.sceMpegAvcDecodeMode, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const modeAddr = regs.getGpr(5) >>> 0;
    if (ctx && modeAddr) {
      const pixelMode = bus.readU32(modeAddr + 4) | 0;
      if (pixelMode >= 0 && pixelMode <= 3) ctx.videoPixelMode = pixelMode;
    }
    regs.setGpr(2, 0);
  });

  // sceMpegAtracDecode(mpeg, auAddr, bufferAddr, init)
  // Diverges from PPSSPP: instead of demuxing+decoding one AT3+ frame here, we
  // serve the next 2048-sample stereo frame (8192 bytes) from the whole-track PCM
  // FFmpeg decodes off the accumulated Program Stream. Silence until the decode
  // catches up; the cursor holds at the start so the intro isn't skipped.
  const ATRAC_FRAME_SAMPLES = 2048; // stereo frames per AU (PPSSPP MediaEngine)
  kernel.register(PSMF.sceMpegAtracDecode, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const auAddr = regs.getGpr(5) >>> 0;
    const bufferAddr = regs.getGpr(6) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    // Consume one packet per audio AU (drives the ringbuffer drain).
    const rbAddr = ctx.ringbufferAddr;
    const avail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.max(0, avail - 1));

    ensureAudioDecode(ctx);
    const out = new Int16Array(ATRAC_FRAME_SAMPLES * 2);
    const pcm = ctx.audioPcm;
    const start = ctx.audioCursor;
    let advance = true;
    if (pcm && (start + ATRAC_FRAME_SAMPLES) * 2 <= pcm.length) {
      out.set(pcm.subarray(start * 2, (start + ATRAC_FRAME_SAMPLES) * 2));
    } else if (!pcm) {
      advance = false; // nothing decoded yet — hold so we don't skip the intro
    }
    if (bufferAddr) {
      bus.writeBytes(bufferAddr, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    }
    if (advance) ctx.audioCursor += ATRAC_FRAME_SAMPLES;

    ctx.audioFrameCount++;
    const { esBuffer } = readAuEs(bus, auAddr);
    const pts = ctx.mpegFirstTimestamp + (ctx.audioFrameCount - 1) * AUDIO_TIMESTAMP_STEP;
    writeAu(bus, auAddr, pts, -1, esBuffer, MPEG_ATRAC_ES_SIZE);
    regs.setGpr(2, 0);
  });

  // sceMpegFlushAllStream(mpeg) — reset the ringbuffer
  kernel.register(PSMF.sceMpegFlushAllStream, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    if (ctx) {
      const rbAddr = ctx.ringbufferAddr;
      bus.writeU32(rbAddr + RB_PACKETS_READ, 0);
      bus.writeU32(rbAddr + RB_PACKETS_WRITE_POS, 0);
      bus.writeU32(rbAddr + RB_PACKETS_AVAIL, 0);
      ctx.videoFrameCount = 0;
      ctx.audioFrameCount = 0;
      ctx.endOfVideoReached = false;
      ctx.endOfAudioReached = false;
      // Stream restart: drop accumulated audio and invalidate any in-flight decode.
      ctx.audioPsChunks = [];
      ctx.audioPsLen = 0;
      ctx.audioPcm = null;
      ctx.audioCursor = 0;
      ctx.audioDecodedFromLen = 0;
      ctx.audioGen++;
    }
    regs.setGpr(2, 0);
  });
}
