/**
 * scePsmfPlayer HLE — High-level video playback for PSP games.
 *
 * Games use scePsmfPlayer to play cutscene PMF files. This module bridges
 * game syscalls to our WebCodecs-based PsmfDecoder, converting decoded
 * ImageBitmap frames to PSP pixel format and writing them to VRAM/RAM.
 *
 * Typical game flow:
 *   Create → SetPsmf(filename) → Start → loop { Update, GetVideoData } → Stop → Delete
 */

import type { MemoryBus } from "../memory/memory-bus.js";
import type { AllegrexRegisters } from "../cpu/registers.js";
import type { HLEKernel } from "./hle-kernel.js";
import { PsmfDecoder, type DecodedFrame } from "../media/psmf-decoder.js";
import { toPhysical, MemoryRegion } from "../memory/memory-map.js";
import { Logger } from "../utils/logger.js";
import { PSMF } from "./nids.js";

const log = Logger.get("PSMF");

// ── PSP status codes ────────────────────────────────────────────────────────

const enum PsmfPlayerStatus {
  INIT      = 0x1,
  STANDBY   = 0x2,
  PLAYING   = 0x4,
  PAUSED    = 0x6, // not in PPSSPP — pause is a playMode, not status
  ERROR     = 0x100,
  FINISHED  = 0x200, // PPSSPP: PSMF_PLAYER_STATUS_PLAYING_FINISHED
}

// ── Player instance ─────────────────────────────────────────────────────────

interface PsmfPlayerInstance {
  status: PsmfPlayerStatus;
  decoder: PsmfDecoder | null;
  decodeReady: boolean;
  decodePromise: Promise<void> | null;
  frames: DecodedFrame[];
  currentFrame: number;
  totalFrames: number;
  videoWidth: number;
  videoHeight: number;
  /** OffscreenCanvas for ImageBitmap → pixel readback */
  readbackCanvas: OffscreenCanvas | null;
  readbackCtx: OffscreenCanvasRenderingContext2D | null;
}

// ── Pixel conversion ────────────────────────────────────────────────────────

/**
 * Write an ImageBitmap frame to PSP memory as ABGR8888 pixels.
 * Uses OffscreenCanvas for readback, then writes to VRAM or RAM.
 */
function writeFrameToMemory(
  frame: DecodedFrame,
  bus: MemoryBus,
  destAddr: number,
  bufWidth: number,
  player: PsmfPlayerInstance,
): void {
  const bitmap = frame.bitmap;
  const w = bitmap.width;
  const h = bitmap.height;

  if (!player.readbackCanvas) {
    player.readbackCanvas = new OffscreenCanvas(w, h);
    player.readbackCtx = player.readbackCanvas.getContext("2d");
  }

  const canvas = player.readbackCanvas;
  const ctx = player.readbackCtx;
  if (!canvas || !ctx) return;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data; // RGBA8888

  // Determine if destination is VRAM for fast path
  const physAddr = toPhysical(destAddr);
  const isVram = physAddr >= MemoryRegion.VRAM_START &&
                 physAddr < MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE;

  if (isVram) {
    // Fast path: write directly to VRAM buffer
    const vramOffset = physAddr - MemoryRegion.VRAM_START;
    const vram32 = new Uint32Array(bus.vramBuffer.buffer);
    for (let y = 0; y < h; y++) {
      const dstRowOffset = (vramOffset + y * bufWidth * 4) >> 2; // u32 offset
      const srcRowOffset = y * w * 4;
      for (let x = 0; x < w; x++) {
        const si = srcRowOffset + x * 4;
        const r = pixels[si], g = pixels[si + 1], b = pixels[si + 2], a = pixels[si + 3];
        if (r === undefined || g === undefined || b === undefined || a === undefined) continue;
        // PSP ABGR8888: [A:31-24][B:23-16][G:15-8][R:7-0]
        vram32[dstRowOffset + x] = (a << 24) | (b << 16) | (g << 8) | r;
      }
    }
  } else {
    // Slow path: per-pixel writeU32
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const r = pixels[si], g = pixels[si + 1], b = pixels[si + 2], a = pixels[si + 3];
        if (r === undefined || g === undefined || b === undefined || a === undefined) continue;
        const abgr = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
        bus.writeU32(destAddr + (y * bufWidth + x) * 4, abgr);
      }
    }
  }
}

// ── String helpers ──────────────────────────────────────────────────────────

function readCString(bus: MemoryBus, addr: number, maxLen = 256): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const b = bus.readU8(addr + i);
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerPsmfPlayerHLE(kernel: HLEKernel): void {
  const bus = kernel.bus;
  const players = new Map<number, PsmfPlayerInstance>();
  let nextPlayerId = 1;

  // Resolve player ID from PSP memory address.
  function getPlayer(contextAddr: number): PsmfPlayerInstance | undefined {
    const id = bus.readU32(contextAddr);
    return players.get(id);
  }

  /** Look up a PSP path via the virtual filesystem (case-insensitive, CWD-aware). */
  function findFile(filename: string): Uint8Array | undefined {
    return kernel.pspFs.getFileData(filename, kernel.currentThreadId);
  }

  /** Load PMF data into a player instance and start async decode. */
  function loadPsmf(player: PsmfPlayerInstance, data: Uint8Array): boolean {
    try {
      const decoder = new PsmfDecoder();
      player.decoder = decoder;
      player.status = PsmfPlayerStatus.STANDBY;
      decoder.onLog = (msg: string) => log.info(msg);
      player.decodePromise = decoder.init(data).then(() => {
        player.totalFrames = decoder.frameCount;
        player.videoWidth = 480; // Default
        player.videoHeight = 272;
        return decoder.decode();
      }).then((frames) => {
        player.frames = frames;
        player.decodeReady = true;
        log.info(`Decode complete: ${frames.length} frames`);
      }).catch((err: Error) => {
        log.warn(`Decode failed: ${err.message}`);
        player.status = PsmfPlayerStatus.ERROR;
      });
      return true;
    } catch (err) {
      log.warn(`PsmfDecoder setup failed: ${String(err)}`);
      player.status = PsmfPlayerStatus.ERROR;
      return false;
    }
  }

  // scePsmfPlayerCreate(contextAddr, ...)
  kernel.register(PSMF.scePsmfPlayerCreate, (regs) => {
    const contextAddr = regs.getGpr(4);
    const id = nextPlayerId++;
    const player: PsmfPlayerInstance = {
      status: PsmfPlayerStatus.INIT,
      decoder: null,
      decodeReady: false,
      decodePromise: null,
      frames: [],
      currentFrame: 0,
      totalFrames: 0,
      videoWidth: 0,
      videoHeight: 0,
      readbackCanvas: null,
      readbackCtx: null,
    };
    players.set(id, player);
    bus.writeU32(contextAddr, id);
    log.info(`PsmfPlayerCreate ctx=0x${contextAddr.toString(16)} → id=${id}`);
    regs.setGpr(2, 0);
  });

  /** Shared handler for SetPsmf variants */
  function handleSetPsmf(regs: AllegrexRegisters): void {
    const contextAddr = regs.getGpr(4);
    const filenameAddr = regs.getGpr(5);
    const filename = readCString(bus, filenameAddr);
    const player = getPlayer(contextAddr);

    if (!player) {
      log.warn(`SetPsmf: no player at ctx=0x${contextAddr.toString(16)}`);
      regs.setGpr(2, 0x80000001 >>> 0);
      return;
    }

    log.info(`PsmfPlayerSetPsmf: "${filename}"`);
    const data = findFile(filename);
    if (!data) {
      log.warn(`PsmfPlayerSetPsmf: file not found "${filename}"`);
      player.status = PsmfPlayerStatus.ERROR;
      regs.setGpr(2, 0x80000001 >>> 0);
      return;
    }

    log.info(`Starting video decode: "${filename}" (${(data.byteLength / 1024).toFixed(0)} KB)`);
    loadPsmf(player, data);
    regs.setGpr(2, 0);
  }

  // scePsmfPlayerSetPsmf(contextAddr, filename)
  kernel.register(PSMF.scePsmfPlayerSetPsmf, handleSetPsmf);
  // scePsmfPlayerSetPsmfCB
  kernel.register(PSMF.scePsmfPlayerSetPsmfCB, handleSetPsmf);
  // scePsmfPlayerSetPsmfOffset(contextAddr, filename, offset)
  kernel.register(PSMF.scePsmfPlayerSetPsmfOffset, handleSetPsmf);
  // scePsmfPlayerSetPsmfOffsetCB
  kernel.register(PSMF.scePsmfPlayerSetPsmfOffsetCB, handleSetPsmf);

  // scePsmfPlayerStart(contextAddr, initData, initPts)
  kernel.register(PSMF.scePsmfPlayerStart, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    if (!player) { regs.setGpr(2, 0x80000001 >>> 0); return; }

    player.currentFrame = 0;
    player.status = PsmfPlayerStatus.PLAYING;
    log.info(`PsmfPlayerStart: ${player.totalFrames} frames`);
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerUpdate(contextAddr)
  kernel.register(PSMF.scePsmfPlayerUpdate, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    if (!player) { regs.setGpr(2, 0x80000001 >>> 0); return; }

    if (player.status === PsmfPlayerStatus.PLAYING && player.decodeReady) {
      player.currentFrame++;
      if (player.currentFrame >= player.totalFrames) {
        player.status = PsmfPlayerStatus.FINISHED;
      }
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerGetVideoData(contextAddr, videoDataAddr)
  kernel.register(PSMF.scePsmfPlayerGetVideoData, (regs) => {
    const contextAddr = regs.getGpr(4);
    const videoDataAddr = regs.getGpr(5);
    const player = getPlayer(contextAddr);
    if (!player || !player.decodeReady) {
      regs.setGpr(2, 0x80000001 >>> 0);
      return;
    }

    // videoData struct: { frameWidth: i32, displayBuf: u32ptr, displayTimeHigh: i32, displayTimeLow: i32 }
    const frameWidth = bus.readU32(videoDataAddr);
    const displayBuf = bus.readU32(videoDataAddr + 4);

    const frameIdx = Math.min(player.currentFrame, player.totalFrames - 1);
    const frame = player.frames[frameIdx];
    if (!frame) {
      regs.setGpr(2, 0x80000001 >>> 0);
      return;
    }

    const bufWidth = frameWidth > 0 ? frameWidth : 512;
    writeFrameToMemory(frame, bus, displayBuf, bufWidth, player);

    // Write PTS back to struct
    const pts = frame.pts;
    bus.writeU32(videoDataAddr + 8, Math.floor(pts / 0x100000000)); // high
    bus.writeU32(videoDataAddr + 12, pts >>> 0);                   // low

    regs.setGpr(2, 0);
  });

  // scePsmfPlayerGetCurrentStatus(contextAddr)
  kernel.register(PSMF.scePsmfPlayerGetCurrentStatus, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    regs.setGpr(2, player ? player.status : PsmfPlayerStatus.ERROR);
  });

  // scePsmfPlayerGetCurrentPts(contextAddr, ptsAddr)
  kernel.register(PSMF.scePsmfPlayerGetCurrentPts, (regs) => {
    const contextAddr = regs.getGpr(4);
    const ptsAddr = regs.getGpr(5);
    const player = getPlayer(contextAddr);
    if (!player || !player.decodeReady) {
      regs.setGpr(2, 0x80000001 >>> 0);
      return;
    }
    const frame = player.frames[Math.min(player.currentFrame, player.totalFrames - 1)];
    if (frame && ptsAddr !== 0) {
      bus.writeU32(ptsAddr, frame.pts >>> 0);
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerStop(contextAddr)
  kernel.register(PSMF.scePsmfPlayerStop, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    if (player) {
      player.status = PsmfPlayerStatus.STANDBY;
      player.currentFrame = 0;
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerReleasePsmf(contextAddr)
  kernel.register(PSMF.scePsmfPlayerReleasePsmf, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    if (player) {
      player.decoder = null;
      player.frames = [];
      player.decodeReady = false;
      player.status = PsmfPlayerStatus.INIT;
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerDelete(contextAddr)
  kernel.register(PSMF.scePsmfPlayerDelete, (regs) => {
    const contextAddr = regs.getGpr(4);
    const id = bus.readU32(contextAddr);
    const player = players.get(id);
    if (player) {
      player.readbackCanvas = null;
      player.readbackCtx = null;
      players.delete(id);
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerBreak(contextAddr)
  kernel.register(PSMF.scePsmfPlayerBreak, (regs) => {
    const contextAddr = regs.getGpr(4);
    const player = getPlayer(contextAddr);
    if (player) player.status = PsmfPlayerStatus.STANDBY;
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerConfigPlayer(contextAddr, configMode, configValue)
  kernel.register(PSMF.scePsmfPlayerConfigPlayer, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerChangePlayMode(contextAddr, mode, value)
  kernel.register(PSMF.scePsmfPlayerChangePlayMode, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerGetCurrentPlayMode(contextAddr, modeAddr, speedAddr)
  kernel.register(PSMF.scePsmfPlayerGetCurrentPlayMode, (regs) => {
    const modeAddr = regs.getGpr(5);
    const speedAddr = regs.getGpr(6);
    if (modeAddr) bus.writeU32(modeAddr, 0);   // normal mode
    if (speedAddr) bus.writeU32(speedAddr, 1);  // 1x speed
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerGetAudioOutSize(contextAddr)
  kernel.register(PSMF.scePsmfPlayerGetAudioOutSize, (regs) => {
    regs.setGpr(2, 2048); // standard audio buffer size
  });

  // scePsmfPlayerGetAudioData(contextAddr, audioDataAddr)
  kernel.register(PSMF.scePsmfPlayerGetAudioData, (regs) => {
    // Stub: write silence
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerGetPsmfInfo(contextAddr, infoAddr)
  kernel.register(PSMF.scePsmfPlayerGetPsmfInfo, (regs) => {
    const contextAddr = regs.getGpr(4);
    const infoAddr = regs.getGpr(5);
    const player = getPlayer(contextAddr);
    if (player && infoAddr) {
      bus.writeU32(infoAddr, player.videoWidth);       // width
      bus.writeU32(infoAddr + 4, player.videoHeight);  // height
      bus.writeU32(infoAddr + 8, player.totalFrames);  // num frames
    }
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerSetTempBuf(contextAddr, bufAddr, bufSize)
  kernel.register(PSMF.scePsmfPlayerSetTempBuf, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerSelectVideo(contextAddr)
  kernel.register(PSMF.scePsmfPlayerSelectVideo, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerSelectAudio(contextAddr)
  kernel.register(PSMF.scePsmfPlayerSelectAudio, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerSelectSpecificVideo(contextAddr, streamNum, channel)
  kernel.register(PSMF.scePsmfPlayerSelectSpecificVideo, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerSelectSpecificAudio(contextAddr, streamNum, channel)
  kernel.register(PSMF.scePsmfPlayerSelectSpecificAudio, (regs) => {
    regs.setGpr(2, 0); // stub
  });

  // scePsmfPlayerGetCurrentVideoStream(contextAddr, streamAddr, channelAddr)
  kernel.register(PSMF.scePsmfPlayerGetCurrentVideoStream, (regs) => {
    const streamAddr = regs.getGpr(5);
    const channelAddr = regs.getGpr(6);
    if (streamAddr) bus.writeU32(streamAddr, 0);
    if (channelAddr) bus.writeU32(channelAddr, 0);
    regs.setGpr(2, 0);
  });

  // scePsmfPlayerGetCurrentAudioStream(contextAddr, streamAddr, channelAddr)
  kernel.register(PSMF.scePsmfPlayerGetCurrentAudioStream, (regs) => {
    const streamAddr = regs.getGpr(5);
    const channelAddr = regs.getGpr(6);
    if (streamAddr) bus.writeU32(streamAddr, 0);
    if (channelAddr) bus.writeU32(channelAddr, 0);
    regs.setGpr(2, 0);
  });

  // scePsmfPlayer_340C12CB — unknown, stub
  kernel.register(PSMF.scePsmfPlayer_340C12CB, (regs) => {
    regs.setGpr(2, 0);
  });

  // sceMpeg handlers live in hle-mpeg.ts (registered after this module).
  const stub0 = (regs: AllegrexRegisters) => { regs.setGpr(2, 0); };

  // ── scePsmf container real handlers ────────────────────────────────────────
  // scePsmfSetPsmf
  kernel.register(PSMF.scePsmfSetPsmf, stub0);
  // scePsmfGetNumberOfStreams
  kernel.register(PSMF.scePsmfGetNumberOfStreams, (regs) => { regs.setGpr(2, 1); });
  // scePsmfGetCurrentStreamType
  kernel.register(PSMF.scePsmfGetCurrentStreamType, stub0);
  // scePsmfSpecifyStreamWithStreamType
  kernel.register(PSMF.scePsmfSpecifyStreamWithStreamType, stub0);
  // scePsmfGetVideoInfo
  kernel.register(PSMF.scePsmfGetVideoInfo, stub0);
  // scePsmfGetAudioInfo
  kernel.register(PSMF.scePsmfGetAudioInfo, stub0);
  // scePsmfVerifyPsmf
  kernel.register(PSMF.scePsmfVerifyPsmf, stub0);
  // scePsmfGetPresentationStartTime
  kernel.register(PSMF.scePsmfGetPresentationStartTime, stub0);
  // scePsmfGetPresentationEndTime
  kernel.register(PSMF.scePsmfGetPresentationEndTime, stub0);
  // scePsmfGetNumberOfEPentries
  kernel.register(PSMF.scePsmfGetNumberOfEPentries, stub0);
  // scePsmfGetHeaderSize
  kernel.register(PSMF.scePsmfGetHeaderSize, (regs) => { regs.setGpr(2, 0x800); });
  // scePsmfGetStreamSize
  kernel.register(PSMF.scePsmfGetStreamSize, (regs) => { regs.setGpr(2, 0); });

}
