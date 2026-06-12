/**
 * HLE sceMpeg implementation — PPSSPP sceMpeg.cpp semantics WITHOUT real video
 * decode. Ringbuffer accounting, PSMF header analysis, AU bookkeeping, and the
 * ringbuffer-fill MipsCall are faithful; AvcDecode writes black frames and
 * AtracDecode writes silence. Games see correct buffer flow, advancing pts,
 * and a clean end-of-stream, so intro videos "play" (black) and finish.
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

  function getCtx(mpeg: number): MpegContext | undefined {
    return contexts.get(mpeg >>> 0);
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
    ctx.isAnalyzed = true;
    log.info(`AnalyzeMpeg: offset=0x${ctx.mpegOffset.toString(16)} size=0x${ctx.mpegStreamSize.toString(16)} ` +
      `ts=${ctx.mpegFirstTimestamp}..${ctx.mpegLastTimestamp} ${ctx.frameWidth}x${ctx.frameHeight} pkts/frame=${ctx.packetsPerVideoFrame}`);
    return true;
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
    const mpeg = regs.getGpr(4) >>> 0;
    const size = regs.getGpr(6) | 0;
    const rbAddr = regs.getGpr(7) >>> 0;
    const frameWidth = regs.getGpr(8) | 0; // $t0
    if (size < MPEG_MEMSIZE) { regs.setGpr(2, SCE_MPEG_ERROR_NO_MEMORY); return; }
    // Fake mpeg struct (PPSSPP writes these markers)
    const magic = "LIBMPEG\x00001\x00";
    for (let i = 0; i < 12; i++) bus.writeU8(mpeg + i, magic.charCodeAt(i));
    bus.writeU32(mpeg + 12, 0xffffffff);
    if (rbAddr !== 0) {
      bus.writeU32(mpeg + 16, rbAddr);
      bus.writeU32(mpeg + 20, bus.readU32(rbAddr + RB_DATA_UPPER_BOUND));
      bus.writeU32(rbAddr + RB_MPEG, mpeg);
    }
    contexts.set(mpeg, {
      mpegAddr: mpeg,
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
    });
    log.info(`sceMpegCreate: mpeg=0x${mpeg.toString(16)} rb=0x${rbAddr.toString(16)} frameWidth=${frameWidth}`);
    regs.setGpr(2, 0);
  });

  kernel.register(PSMF.sceMpegDelete, (regs) => {
    const handle = regs.getGpr(4) >>> 0;
    getCtx(handle)?.decoder?.dispose();
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
      const packetsThisRound = Math.min(numPackets, packets - writeOffset);
      kernel._invokeGeCb(cbAddr, (data + writeOffset * 2048) >>> 0, packetsThisRound, cbArg);
      const added = kernel.lastGuestCallReturnValue | 0;
      if (added > 0) {
        const rbRead = bus.readU32(rbAddr + RB_PACKETS_READ) | 0;
        const rbWrite = bus.readU32(rbAddr + RB_PACKETS_WRITE_POS) | 0;
        const rbAvail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
        bus.writeU32(rbAddr + RB_PACKETS_READ, rbRead + added);
        bus.writeU32(rbAddr + RB_PACKETS_WRITE_POS, rbWrite + added);
        bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.min(packets, rbAvail + added));
        totalAdded += added;
        // Feed the freshly written Program Stream bytes to the real decoder.
        const ctx = getCtx(bus.readU32(rbAddr + RB_MPEG) >>> 0);
        if (ctx?.decoder) {
          ctx.decoder.feed(bus.readBytes((data + writeOffset * 2048) >>> 0, added * 2048));
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

  // sceMpegAvcDecode(mpeg, auAddr, frameWidth, bufferAddr, initAddr)
  kernel.register(PSMF.sceMpegAvcDecode, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const auAddr = regs.getGpr(5) >>> 0;
    let frameWidth = regs.getGpr(6) | 0;
    const bufferAddr = regs.getGpr(7) >>> 0;
    const initAddr = regs.getGpr(8) >>> 0;  // 5th arg in $t0
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    if (frameWidth === 0) frameWidth = ctx.defaultFrameWidth || ctx.frameWidth;
    const rbAddr = ctx.ringbufferAddr;
    const packetsRead = bus.readU32(rbAddr + RB_PACKETS_READ) | 0;
    if (packetsRead === 0 || ctx.endOfVideoReached) {
      regs.setGpr(2, SCE_MPEG_ERROR_AVC_DECODE_FATAL);
      return;
    }

    // Consume packets (no demuxer: average rate computed from the PSMF header)
    const avail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.max(0, avail - ctx.packetsPerVideoFrame));

    // Real decoded frame if libav has one ready, else the placeholder
    // black-frame-with-label so the user still sees which video is "playing".
    const dest = bus.readU32(bufferAddr) >>> 0;
    if (dest !== 0) {
      const h = ctx.frameHeight || 272;
      const w = Math.min(frameWidth, ctx.frameWidth || frameWidth);
      const realFrame = ctx.decoder?.takeVideoFrame() ?? null;
      if (realFrame) {
        packRgbaToFrame(bus, dest, frameWidth, h, ctx.videoPixelMode,
          realFrame.rgba, realFrame.width, realFrame.height);
      } else {
        if (ctx.videoPixelMode === 3) {
          for (let y = 0; y < h; y++) {
            const row = dest + y * frameWidth * 4;
            for (let x = 0; x < w; x++) bus.writeU32(row + x * 4, 0xff000000);
          }
        } else {
          const bpp = 2;
          const black = ctx.videoPixelMode === 1 ? 0x8000 : ctx.videoPixelMode === 2 ? 0xf000 : 0x0000;
          for (let y = 0; y < h; y++) {
            const row = dest + y * frameWidth * bpp;
            for (let x = 0; x < w; x++) bus.writeU16(row + x * 2, black);
          }
        }

        const name = kernel.lastVideoPath ?? "MPEG VIDEO";
        const total = Math.max(1, Math.round((ctx.mpegLastTimestamp - ctx.mpegFirstTimestamp) / VIDEO_TIMESTAMP_STEP));
        const info = `${ctx.frameWidth}X${ctx.frameHeight}  ${ctx.videoFrameCount + 1}/${total}`;
        const scale = 2;
        const ty = Math.max(0, (h >> 1) - GLYPH_H * scale);
        drawText(bus, dest, frameWidth, h, ctx.videoPixelMode,
          Math.max(0, (w - textWidth(name, scale)) >> 1), ty, name, scale);
        drawText(bus, dest, frameWidth, h, ctx.videoPixelMode,
          Math.max(0, (w - textWidth(info, scale)) >> 1), ty + GLYPH_H * scale + scale * 2, info, scale, [160, 160, 160, 255]);
      }
    }

    ctx.videoFrameCount++;
    const { esBuffer } = readAuEs(bus, auAddr);
    const pts = ctx.mpegFirstTimestamp + (ctx.videoFrameCount - 1) * VIDEO_TIMESTAMP_STEP;
    writeAu(bus, auAddr, pts, pts - VIDEO_TIMESTAMP_STEP, esBuffer, MPEG_AVC_ES_SIZE);
    if (initAddr) bus.writeU32(initAddr, 1); // avcDecodeResult = MPEG_AVC_DECODE_SUCCESS
    regs.setGpr(2, 0);
  });

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
  kernel.register(PSMF.sceMpegAtracDecode, (regs, bus) => {
    const ctx = getCtx(regs.getGpr(4));
    const auAddr = regs.getGpr(5) >>> 0;
    const bufferAddr = regs.getGpr(6) >>> 0;
    if (!ctx) { regs.setGpr(2, -1 >>> 0); return; }
    // Consume one packet per audio AU
    const rbAddr = ctx.ringbufferAddr;
    const avail = bus.readU32(rbAddr + RB_PACKETS_AVAIL) | 0;
    bus.writeU32(rbAddr + RB_PACKETS_AVAIL, Math.max(0, avail - 1));
    // Write silence
    if (bufferAddr) {
      for (let i = 0; i < MPEG_ATRAC_ES_OUTPUT_SIZE; i += 4) bus.writeU32(bufferAddr + i, 0);
    }
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
    }
    regs.setGpr(2, 0);
  });
}
