/**
 * HLE audio handlers for sceAudio and sceAtrac.
 *
 * Registered at HLEKernel construction time (before remapSyscalls) so that
 * NID→handler entries exist when the ELF import-stub patcher maps NIDs to
 * syscall codes.
 *
 * AudioEngine is read from kernel.audioEngine at each call site.  This means
 * audio NIDs silently no-op until the frontend calls kernel.setupAudio(), which
 * is correct: the game's audio thread keeps running but produces no output
 * until the browser's AudioContext is unlocked by a user gesture.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel, HLEHandler } from "./hle-kernel.js";
import { parseAtracHeader, decodeAtrac, getCachedAtrac, getCachedAtracBySize, type AtracInfo } from "../audio/atrac-decoder.js";
import { Mp3FrameAccumulator, decodeAudioFrame } from "../audio/frame-decoder.js";
import { AUDIO, ATRAC, AAC, AUDIOCODEC, VAUDIO, MP3, MP4 } from "./nids.js";
import { int16ToB64, b64ToInt16 } from "../state/binutil.js";

const log = Logger.get("HLE-AUDIO");
const atracDecodeCallCount = new Map<number, number>();

/** PSP_AUDIO_FORMAT_MONO as defined in PSP SDK / PPSSPP sceAudio.h */
const PSP_AUDIO_FORMAT_MONO = 0x10;

// AtracStatus mirrors PPSSPP AtracBase.h
const enum AtracStatus {
  NO_DATA               = 1,
  ALL_DATA_LOADED       = 2,
  HALFWAY_BUFFER        = 3,
  STREAMED_WITHOUT_LOOP = 4,
  STREAMED_LOOP_FROM_END = 5,
  STREAMED_LOOP_WITH_TRAILER = 6,
  LOW_LEVEL             = 8,
  FOR_SCESAS            = 16,
}

const SCE_ERROR_ATRAC_NO_ATRACID           = 0x80630003;
const SCE_ERROR_ATRAC_INVALID_CODECTYPE    = 0x80630004;
const SCE_ERROR_ATRAC_BAD_ATRACID          = 0x80630005;
const SCE_ERROR_ATRAC_ALL_DATA_LOADED      = 0x80630009;
const SCE_ERROR_ATRAC_NO_DATA              = 0x80630010;
const SCE_ERROR_ATRAC_INCORRECT_READ_SIZE  = 0x80630013;
const SCE_ERROR_ATRAC_BAD_ALIGNMENT        = 0x80630014;
const SCE_ERROR_ATRAC_IS_LOW_LEVEL         = 0x80630031;
const SCE_ERROR_ATRAC_IS_FOR_SCESAS        = 0x80630040;

const PSP_CODEC_AT3PLUS = 0x00001000;
const PSP_CODEC_AT3     = 0x00001001;

// ── AtracContext ──────────────────────────────────────────────────────────────

interface AtracContext {
  id: number;
  info: AtracInfo;
  decodedPcm: Int16Array | null;
  decodePos: number;  // in frames
  decoding: boolean;
  /** Marked true by sceAtracReleaseAtracID — context kept alive so the playback
   *  thread can continue calling sceAtracDecodeData after the decode worker exits. */
  released: boolean;
  /** Loop count from sceAtracSetLoopNum: 0 = no loop, -1 = infinite, >0 = N loops.
   *  PPSSPP AtracCtx.cpp: loopNum_ starts 0; looping only happens when != 0. */
  loopNum: number;
  /** PSP RAM address of the AT3 buffer (for streaming re-read on AddStreamData). */
  bufPtr: number;
  /** Total size of the AT3 buffer as passed to SetDataAndGetID. */
  bufSize: number;
  status: AtracStatus;
  codecType: number;
}

// ── atracDecodeData helper ────────────────────────────────────────────────────

/**
 * Shared implementation for the two sceAtracDecodeData NIDs.
 * Writes a decoded PCM frame (or silence) into the guest output buffer and
 * updates all output pointers.
 */
function atracDecodeData(
  bus: HLEKernel["bus"],
  ctx: AtracContext | undefined,
  outAddr: number,
  numSamplesPtr: number,
  finishFlagPtr: number,
  remainPtr: number,
): void {
  const samplesPerFrame = ctx?.info.samplesPerFrame ?? 512;

  if (!ctx?.decodedPcm) {
    // Decode unavailable (still running, failed, or no audio backend) — write
    // silence but keep correct stream pacing: advance the position and raise
    // the finish flag at the track's declared end so games that wait for a
    // sound to end don't hang, and BGM player threads don't bail out early.
    if (outAddr !== 0) {
      bus.writeBytes(outAddr, new Uint8Array(samplesPerFrame * 4));
    }
    let finishFlag = 0;
    if (ctx) {
      const total = ctx.info.totalSamples;
      ctx.decodePos += samplesPerFrame;
      if (total > 0 && ctx.decodePos >= total) {
        const hasLoop = ctx.info.loopStart >= 0 && ctx.info.loopEnd > ctx.info.loopStart;
        if (hasLoop && ctx.loopNum !== 0) {
          ctx.decodePos = ctx.info.loopStart;
          if (ctx.loopNum > 0) ctx.loopNum--;
        } else {
          finishFlag = 1;
        }
      }
    }
    if (numSamplesPtr !== 0) bus.writeU32(numSamplesPtr, samplesPerFrame);
    if (finishFlagPtr !== 0) bus.writeU32(finishFlagPtr, finishFlag);
    if (remainPtr     !== 0) bus.writeU32(remainPtr, ctx && ctx.status === AtracStatus.ALL_DATA_LOADED ? (-1 >>> 0) : 2);
    return;
  }

  const channels       = ctx.info.channels;
  const totalPcmFrames = ctx.decodedPcm.length / channels;
  const start          = ctx.decodePos;
  const end            = Math.min(start + samplesPerFrame, totalPcmFrames);
  const actualSamples  = end - start;

  if (outAddr !== 0) {
    const slice = ctx.decodedPcm.subarray(start * channels, end * channels);
    bus.writeBytes(outAddr, new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength));
  }

  ctx.decodePos = end;

  // Handle looping at end of stream — PPSSPP Atrac::DecodeData loops only when
  // loopNum != 0 (set via sceAtracSetLoopNum; -1 = infinite, >0 counts down)
  // and the track has valid loop points.
  const hasLoop =
    ctx.info.loopStart >= 0 && ctx.info.loopEnd > ctx.info.loopStart;
  let finishFlag: number;
  if (end >= totalPcmFrames) {
    if (hasLoop && ctx.loopNum !== 0) {
      ctx.decodePos = ctx.info.loopStart;
      if (ctx.loopNum > 0) ctx.loopNum--;
      finishFlag = 0;
      log.info(`sceAtracDecodeData id=${ctx.id}: loop wrap loopStart=${ctx.info.loopStart} loopNum=${ctx.loopNum}`);
    } else {
      finishFlag = 1;
      log.info(`sceAtracDecodeData id=${ctx.id}: end of stream (no loop), finishFlag=1 totalFrames=${totalPcmFrames}`);
    }
  } else {
    finishFlag = 0;
  }

  if (numSamplesPtr !== 0) bus.writeU32(numSamplesPtr, actualSamples);
  if (finishFlagPtr !== 0) bus.writeU32(finishFlagPtr, finishFlag);

  // PPSSPP Atrac::RemainingFrames — ALL_DATA_LOADED returns
  // PSP_ATRAC_ALLDATA_IS_ON_MEMORY (-1), not a frame count.
  const remainFrames = ctx.status === AtracStatus.ALL_DATA_LOADED
    ? (-1 >>> 0)
    : Math.max(0, Math.ceil((totalPcmFrames - ctx.decodePos) / samplesPerFrame));
  if (remainPtr !== 0) bus.writeU32(remainPtr, remainFrames);

  // Log first 20 calls per atrac id to trace game behaviour
  const callN = (atracDecodeCallCount.get(ctx.id) ?? 0) + 1;
  atracDecodeCallCount.set(ctx.id, callN);
  if (callN <= 5) {
    log.debug(`atracDec id=${ctx.id} #${callN} pos=${start}→${ctx.decodePos} samples=${actualSamples} remain=${remainFrames} finish=${finishFlag}`);
  }
}

// ── registerAudioHLE ─────────────────────────────────────────────────────────

/**
 * Register real sceAudio + sceAtrac handlers on `kernel`.
 *
 * Must be called at construction time (before remapSyscalls) so that handlers
 * are present when the ELF import-stub patcher maps NIDs to syscall codes.
 */
export function registerAudioHLE(kernel: HLEKernel): void {

  const atracContexts = new Map<number, AtracContext>();
  // PSP_MAX_ATRAC_IDS = 6 (matches PPSSPP sceAtrac.h).
  const MAX_ATRAC_IDS = 6;

  // Slot 0,1=AT3PLUS; 2,3=AT3; 4,5=untyped — matches PPSSPP __AtracInit()
  const atracContextTypes: number[] = [
    PSP_CODEC_AT3PLUS, PSP_CODEC_AT3PLUS,
    PSP_CODEC_AT3,     PSP_CODEC_AT3,
    0, 0,
  ];

  function allocAtracID(codecType: number): number {
    for (let i = 0; i < MAX_ATRAC_IDS; i++) {
      if ((atracContextTypes[i] === codecType || atracContextTypes[i] === 0) && !atracContexts.has(i)) {
        atracContextTypes[i] = codecType;
        return i;
      }
    }
    // All slots occupied — try reclaiming a finished context of matching type.
    // Some games never call sceAtracReleaseAtracID after playback ends.
    for (let i = 0; i < MAX_ATRAC_IDS; i++) {
      const ctx = atracContexts.get(i);
      if (ctx && atracContextTypes[i] === codecType && !ctx.decoding &&
          ctx.decodedPcm !== null && ctx.decodePos >= ctx.info.totalSamples) {
        log.warn(`allocAtracID: reclaiming finished slot ${i} for codec 0x${codecType.toString(16)}`);
        atracContexts.delete(i);
        atracDecodeCallCount.delete(i);
        return i;
      }
    }
    // Also try reclaiming any finished slot regardless of type
    for (let i = 0; i < MAX_ATRAC_IDS; i++) {
      const ctx = atracContexts.get(i);
      if (ctx && !ctx.decoding &&
          ctx.decodedPcm !== null && ctx.decodePos >= ctx.info.totalSamples) {
        log.warn(`allocAtracID: reclaiming finished slot ${i} (type mismatch, was 0x${atracContextTypes[i]!.toString(16)})`);
        atracContexts.delete(i);
        atracDecodeCallCount.delete(i);
        atracContextTypes[i] = codecType;
        return i;
      }
    }
    // Last resort: reclaim any non-decoding slot (failed decode, stale context)
    for (let i = 0; i < MAX_ATRAC_IDS; i++) {
      const ctx = atracContexts.get(i);
      if (ctx && !ctx.decoding && !atracWaiters.has(i)) {
        log.warn(`allocAtracID: force-reclaiming stale slot ${i} (pcm=${ctx.decodedPcm !== null}, pos=${ctx.decodePos}/${ctx.info.totalSamples})`);
        atracContexts.delete(i);
        atracDecodeCallCount.delete(i);
        atracContextTypes[i] = codecType;
        return i;
      }
    }
    return -1;
  }

  /** Thread IDs waiting for a specific atracId to finish decoding. */
  const atracWaiters = new Map<number, number[]>();
  /** Rate-limit success logs: channel → call count */
  const outputCallCount = new Map<number, number>();
  /** Fake channel counter for when audio engine is disabled */
  let fakeNextCh = 0;

  // ── sceAudioChReserve(channel, sampleCount, format) → channelIndex ──────
  // Always succeed even when audio is disabled — games expect channel reservation to work.
  // Actual PCM output is silently discarded when the engine is off.
  kernel.register(AUDIO.sceAudioChReserve, (regs) => {
    const engine = kernel.audioEngine;
    let ch: number;
    if (engine) {
      // Record channel state even when the engine isn't initialized yet (audio
      // disabled / headless): blocking output calls read ch.sampleCount to know
      // how long to block. Leaving it 0 makes audio threads spin forever.
      ch = engine.reserveChannel(regs.getGpr(4) >>> 0, regs.getGpr(5) >>> 0, regs.getGpr(6) >>> 0);
    } else {
      // No engine at all — auto-assign a fake channel index so the game proceeds
      const req = regs.getGpr(4) | 0;
      ch = req === -1 ? (fakeNextCh < 8 ? fakeNextCh++ : -1) : (req < 8 ? req : -1);
    }
    log.info(`sceAudioChReserve: tid=${kernel.currentThreadId} req=${regs.getGpr(4) | 0} samples=${regs.getGpr(5)} fmt=${regs.getGpr(6)} → ch=${ch}`);
    regs.setGpr(2, ch >>> 0);
  });

  // ── sceAudioChRelease(channel) → 0 ──────────────────────────────────────
  kernel.register(AUDIO.sceAudioChRelease, (regs) => {
    kernel.audioEngine?.releaseChannel(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // ── PCM output helper — read samples from RAM and enqueue ────────────────
  function outputPcm(
    regs: Parameters<HLEHandler>[0],
    bus: Parameters<HLEHandler>[1],
    chanIdx: number,
    leftVol: number,
    rightVol: number,
    bufPtr: number,
    blocking: boolean,
  ): void {
    const engine = kernel.audioEngine;
    const ch = engine?.getChannel(chanIdx);

    if (engine?.isReady && ch?.reserved && bufPtr !== 0) {
      const mono           = ch.format === PSP_AUDIO_FORMAT_MONO;
      const bytesPerSample = mono ? 2 : 4;
      const raw  = bus.readBytes(bufPtr, ch.sampleCount * bytesPerSample);
      const pcm  = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      engine.enqueueFrames(pcm, leftVol, rightVol, ch.sampleCount, mono, chanIdx);
      // Real PSP: sceAudioOutputBlocking returns 0 (all samples played when
      // it unblocks); sceAudioOutput returns queued sample count.  Returning
      // ch.sampleCount for blocking calls was causing games to interpret the
      // value as "samples still pending" and incorrectly fade the BGM.
      regs.setGpr(2, blocking ? 0 : ch.sampleCount);
      // Rate-limited log: first 3 calls per channel, then every 200
      const n = (outputCallCount.get(chanIdx) ?? 0) + 1;
      outputCallCount.set(chanIdx, n);
      if (n <= 3 || n % 200 === 0) {
        log.info(`outputPcm ch=${chanIdx} tid=${kernel.currentThreadId} vol=${leftVol}/${rightVol} buf=0x${bufPtr.toString(16)} samples=${ch.sampleCount} #${n}`);
      }
    } else {
      log.debug(`outputPcm: no-op ch=${chanIdx} reserved=${ch?.reserved} bufPtr=0x${bufPtr.toString(16)} tid=${kernel.currentThreadId}`);
      regs.setGpr(2, 0);
    }

    if (blocking) {
      // Always block for the duration of the audio buffer, even when audio is
      // disabled. The PSP DMA takes time regardless of output. Without this,
      // audio threads spin infinitely when the engine is off. Guard against a
      // zero sampleCount for the same reason.
      const samples = ch?.sampleCount || 512;
      kernel.blockForAudio(regs, samples, 44_100);
    }
  }

  // ── sceAudioOutputBlocking(channel, vol, bufPtr) ─────────────────────────
  kernel.register(AUDIO.sceAudioOutputBlocking, (regs, bus) => {
    outputPcm(regs, bus, regs.getGpr(4), regs.getGpr(5), regs.getGpr(5), regs.getGpr(6), true);
  });

  // ── sceAudioOutputPannedBlocking(channel, volL, volR, bufPtr) ────────────
  kernel.register(AUDIO.sceAudioOutputPannedBlocking, (regs, bus) => {
    outputPcm(regs, bus, regs.getGpr(4), regs.getGpr(5), regs.getGpr(6), regs.getGpr(7), true);
  });

  // ── sceAudioOutputPanned (non-blocking) ──────────────────────────────────
  kernel.register(AUDIO.sceAudioOutputPanned, (regs, bus) => {
    outputPcm(regs, bus, regs.getGpr(4), regs.getGpr(5), regs.getGpr(6), regs.getGpr(7), false);
  });

  // ── sceAudioOutput (non-blocking, mono vol) ──────────────────────────────
  kernel.register(AUDIO.sceAudioOutput, (regs, bus) => {
    outputPcm(regs, bus, regs.getGpr(4), regs.getGpr(5), regs.getGpr(5), regs.getGpr(6), false);
  });

  // ── sceAudioChangeChannelVolume(chan, volL, volR) ────────────────────────
  kernel.register(AUDIO.sceAudioChangeChannelVolume, (regs) => {
    const ch = kernel.audioEngine?.getChannel(regs.getGpr(4));
    if (ch) { ch.leftVol = regs.getGpr(5); ch.rightVol = regs.getGpr(6); }
    regs.setGpr(2, 0);
  });

  // ── sceAudioSetChannelDataLen(chan, len) ─────────────────────────────────
  kernel.register(AUDIO.sceAudioSetChannelDataLen, (regs) => {
    const ch = kernel.audioEngine?.getChannel(regs.getGpr(4));
    if (ch) ch.sampleCount = regs.getGpr(5);
    regs.setGpr(2, 0);
  });

  // ── sceAudioChangeChannelConfig(chan, format) ────────────────────────────
  kernel.register(AUDIO.sceAudioChangeChannelConfig, (regs) => {
    const ch = kernel.audioEngine?.getChannel(regs.getGpr(4));
    if (ch) ch.format = regs.getGpr(5);
    regs.setGpr(2, 0);
  });

  // ── sceAudioGetChannelRestLen / RestLength ───────────────────────────────
  kernel.register(AUDIO.sceAudioGetChannelRestLen, (regs) => { regs.setGpr(2, kernel.audioEngine?.getRestSamples() ?? 0); });
  kernel.register(AUDIO.sceAudioGetChannelRestLength, (regs) => { regs.setGpr(2, kernel.audioEngine?.getRestSamples() ?? 0); });

  // ── sceAudioSRCChReserve(sampleCount, freq, format) ─────────────────────
  kernel.register(AUDIO.sceAudioSRCChReserve, (regs) => {
    kernel.audioEngine?.reserveSRC(regs.getGpr(4), regs.getGpr(5), regs.getGpr(6));
    regs.setGpr(2, 0);
  });

  // ── sceAudioSRCChRelease() ───────────────────────────────────────────────
  kernel.register(AUDIO.sceAudioSRCChRelease, (regs) => {
    kernel.audioEngine?.releaseSRC();
    regs.setGpr(2, 0);
  });

  // ── sceAudioSRCOutputBlocking(vol, bufPtr) ───────────────────────────────
  kernel.register(AUDIO.sceAudioSRCOutputBlocking, (regs, bus) => {
    const engine = kernel.audioEngine;
    const ch     = engine?.getChannel(8); // SRC channel
    const bufPtr = regs.getGpr(5);
    if (engine?.isReady && ch && bufPtr !== 0) {
      const raw = bus.readBytes(bufPtr, ch.sampleCount * 4);
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      engine.enqueueFrames(pcm, regs.getGpr(4), regs.getGpr(4), ch.sampleCount, false, 8);
      regs.setGpr(2, ch.sampleCount);
      log.debug(`sceAudioSRCOutputBlocking: vol=${regs.getGpr(4)} samples=${ch.sampleCount}`);
    } else {
      log.info(`sceAudioSRCOutputBlocking: no-op bufPtr=0x${bufPtr.toString(16)} ch=${ch?.reserved}`);
      regs.setGpr(2, 0);
    }
    // Always block — even with no audio backend, the call paces the thread
    // (see outputPcm). Never blocking makes SRC audio threads spin forever.
    kernel.blockForAudio(regs, (ch?.sampleCount || 512), engine?.srcRate || 44_100);
  });

  // ── sceAudioOutput2 API (single shared stereo channel, index 9) ──────────

  // sceAudioOutput2Reserve(sampleCount) → 0
  kernel.register(AUDIO.sceAudioOutput2Reserve, (regs) => {
    const sc = regs.getGpr(4);
    kernel.audioEngine?.reserveOutput2(sc);
    log.debug(`sceAudioOutput2Reserve: sampleCount=${sc}`);
    regs.setGpr(2, 0);
  });

  // sceAudioOutput2Release() → 0
  kernel.register(AUDIO.sceAudioOutput2Release, (regs) => {
    kernel.audioEngine?.releaseOutput2();
    regs.setGpr(2, 0);
  });

  // sceAudioOutput2OutputBlocking(vol, bufPtr) → 0
  kernel.register(AUDIO.sceAudioOutput2OutputBlocking, (regs, bus) => {
    const engine = kernel.audioEngine;
    const ch     = engine?.getOutput2Channel();
    const vol    = regs.getGpr(4);
    const bufPtr = regs.getGpr(5);
    if (engine?.isReady && ch && bufPtr !== 0) {
      const raw = bus.readBytes(bufPtr, ch.sampleCount * 4); // stereo s16le
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      engine.enqueueFrames(pcm, vol, vol, ch.sampleCount, false, 9);
      regs.setGpr(2, ch.sampleCount);
      log.debug(`sceAudioOutput2OutputBlocking: vol=${vol} samples=${ch.sampleCount}`);
    } else {
      log.debug(`sceAudioOutput2OutputBlocking: no-op ch=${ch?.reserved} bufPtr=0x${bufPtr.toString(16)}`);
      regs.setGpr(2, 0);
    }
    // Always block — paces the game's mixer thread even with no audio backend.
    kernel.blockForAudio(regs, (ch?.sampleCount || 512), 44_100);
  });

  // sceAudioOutput2GetRestSample() → 0
  kernel.register(AUDIO.sceAudioOutput2GetRestSample, (regs) => { regs.setGpr(2, kernel.audioEngine?.getRestSamples() ?? 0); });

  // ────────────────────────────────────────────────────────────────────────
  // sceAtrac handlers
  // ────────────────────────────────────────────────────────────────────────

  /** Start an async ATRAC decode and store the context. */
  function beginAtracDecode(id: number, data: Uint8Array, bufPtr = 0, bufSize = 0, status: AtracStatus = AtracStatus.ALL_DATA_LOADED, codecType: number = PSP_CODEC_AT3PLUS): void {
    let info: AtracInfo;
    try {
      info = parseAtracHeader(data);
    } catch (err) {
      // Buffer may be empty/uninitialized (streaming pattern: game passes a buffer
      // address before filling it via sceIoRead).  Try to find pre-warmed PCM by
      // the declared buffer size so the atrac ID still produces audio.
      const sizeGuess = bufSize || data.byteLength;
      const sizeHit   = sizeGuess > 0 ? getCachedAtracBySize(sizeGuess, id) : null;
      if (sizeHit) {
        log.debug(`sceAtrac id=${id}: empty buffer — size-based cache hit (bufAlloc=${sizeGuess}, fileSize=${sizeHit.fileSize}, ${sizeHit.pcm.length} samples)`);
        atracContexts.set(id, { id, info: sizeHit.info, decodedPcm: sizeHit.pcm, decodePos: 0, decoding: false, released: false, loopNum: 0, bufPtr, bufSize, status, codecType });
        return;
      }
      log.warn(`sceAtrac id=${id}: header parse failed: ${err}`);
      info = { codecType: "AT3", totalSamples: 0, loopStart: -1, loopEnd: -1, channels: 2, sampleRate: 44100, samplesPerFrame: 512 };
      atracContexts.set(id, { id, info, decodedPcm: null, decodePos: 0, decoding: false, released: false, loopNum: 0, bufPtr, bufSize, status, codecType });
      return;
    }

    // Check if already decoded (pre-warmed or previously decoded)
    const cached = getCachedAtrac(data);
    if (cached) {
      log.debug(`sceAtrac id=${id}: cache hit, ${cached.length / info.channels} frames, totalSamples=${info.totalSamples}, loop=${info.loopStart}..${info.loopEnd}`);
      atracContexts.set(id, { id, info, decodedPcm: cached, decodePos: 0, decoding: false, released: false, loopNum: 0, bufPtr, bufSize, status, codecType });
      return;
    }

    atracContexts.set(id, { id, info, decodedPcm: null, decodePos: 0, decoding: true, released: false, loopNum: 0, bufPtr, bufSize, status, codecType });

    decodeAtrac(data, info).then((pcm) => {
      const ctx = atracContexts.get(id);
      if (ctx) { ctx.decodedPcm = pcm; ctx.decoding = false; }
      log.info(`sceAtrac id=${id}: decoded ${pcm.length / info.channels} frames`);
      const waiters = atracWaiters.get(id);
      if (waiters) {
        atracWaiters.delete(id);
        for (const tid of waiters) kernel.pendingAtracWakes.add(tid);
      }
    }).catch((err: unknown) => {
      log.warn(`sceAtrac id=${id}: decode failed: ${err}`);
      const ctx = atracContexts.get(id);
      if (ctx) ctx.decoding = false;
      // Wake waiters even on failure so they don't hang forever
      const waiters = atracWaiters.get(id);
      if (waiters) {
        atracWaiters.delete(id);
        for (const tid of waiters) kernel.pendingAtracWakes.add(tid);
      }
    });
  }

  // ── sceAtracSetDataAndGetID(buf, size) → atracID ─────────────────────────
  kernel.register(ATRAC.sceAtracSetDataAndGetID, (regs, bus) => {
    const ptr  = regs.getGpr(4);
    const size = regs.getGpr(5);
    // Parse header to detect codec type
    let codecType = PSP_CODEC_AT3PLUS;
    try {
      const headerData = bus.readBytes(ptr, Math.min(size, 128));
      const info = parseAtracHeader(headerData);
      codecType = info.codecType === "AT3" ? PSP_CODEC_AT3 : PSP_CODEC_AT3PLUS;
    } catch (_) { /* keep default */ }
    const id = allocAtracID(codecType);
    if (id < 0) {
      log.warn(`sceAtracSetDataAndGetID: no free atrac IDs (max ${MAX_ATRAC_IDS})`);
      regs.setGpr(2, SCE_ERROR_ATRAC_NO_ATRACID);
      return;
    }
    log.debug(`sceAtracSetDataAndGetID: ptr=0x${ptr.toString(16)} size=${size} → id=${id}`);
    beginAtracDecode(id, bus.readBytes(ptr, size), ptr, size, AtracStatus.ALL_DATA_LOADED, codecType);
    regs.setGpr(2, id);
  });

  // ── sceAtracSetHalfwayBufferAndGetID(buf, readSize, bufSize) → atracID ───
  kernel.register(ATRAC.sceAtracSetHalfwayBufferAndGetID, (regs, bus) => {
    const ptr      = regs.getGpr(4);
    const readSize = regs.getGpr(5) >>> 0;
    const bSize    = regs.getGpr(6) >>> 0;
    if (readSize > bSize) {
      regs.setGpr(2, SCE_ERROR_ATRAC_INCORRECT_READ_SIZE);
      return;
    }
    // Parse header to detect codec type
    let codecType = PSP_CODEC_AT3PLUS;
    try {
      const headerData = bus.readBytes(ptr, Math.min(readSize, 128));
      const info = parseAtracHeader(headerData);
      codecType = info.codecType === "AT3" ? PSP_CODEC_AT3 : PSP_CODEC_AT3PLUS;
    } catch (_) { /* keep default */ }
    const id = allocAtracID(codecType);
    if (id < 0) {
      log.warn(`sceAtracSetHalfwayBufferAndGetID: no free atrac IDs (max ${MAX_ATRAC_IDS})`);
      regs.setGpr(2, SCE_ERROR_ATRAC_NO_ATRACID);
      return;
    }
    const atracStatus = readSize === bSize ? AtracStatus.ALL_DATA_LOADED : AtracStatus.HALFWAY_BUFFER;
    log.debug(`sceAtracSetHalfwayBufferAndGetID: ptr=0x${ptr.toString(16)} readSize=${readSize} bufSize=${bSize} → id=${id}`);
    beginAtracDecode(id, bus.readBytes(ptr, readSize), ptr, bSize, atracStatus, codecType);
    regs.setGpr(2, id);
  });

  // ── sceAtracDecodeData(id, out, numSamplesPtr, finishFlagPtr, remainPtr) ──
  // NID: 0x6a8c3cd5 (PPSSPP canonical)
  const decodeHandler: HLEHandler = (regs, bus) => {
    // NOTE: this must work even when the audio engine is unavailable —
    // PPSSPP's Atrac::DecodeData always writes numSamples/finishFlag/remains.
    // Skipping the writes leaves garbage in the out-params and games kill
    // their BGM threads when they read a bogus finish flag.
    const id  = regs.getGpr(4);
    const ctx = atracContexts.get(id);
    const outAddr = regs.getGpr(5);

    // Alignment check
    if (outAddr & 1) {
      regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ALIGNMENT);
      return;
    }

    if (ctx?.decoding) {
      // ATRAC decode still in progress — block this thread until it completes,
      // then write the output from the wake callback so the game gets real PCM.
      const numSamplesPtr = regs.getGpr(6);
      const finishFlagPtr = regs.getGpr(7);
      const remainPtr     = regs.getGpr(8);
      const waiters       = atracWaiters.get(id) ?? [];
      if (!waiters.includes(kernel.currentThreadId)) waiters.push(kernel.currentThreadId);
      atracWaiters.set(id, waiters);
      log.warn(`sceAtracDecodeData id=${id}: blocking thread ${kernel.currentThreadId} until decode completes (AT3 was not pre-warmed!`);
      kernel.blockAtracDecode(regs, () => {
        log.info(`sceAtracDecodeData id=${id}: decode ready, writing output for thread`);
        atracDecodeData(bus, atracContexts.get(id), outAddr, numSamplesPtr, finishFlagPtr, remainPtr);
      });
      return; // context saved — resumes after SYSCALL once decode is done
    }

    atracDecodeData(
      bus,
      ctx,
      outAddr,
      regs.getGpr(6),
      regs.getGpr(7),
      regs.getGpr(8),
    );
    regs.setGpr(2, 0);
  };
  kernel.register(ATRAC.sceAtracDecodeData, decodeHandler); // 0x6a8c3cd5 — PPSSPP canonical

  // ── sceAtracGetRemainFrame(id, remainAddr) ───────────────────────────────
  // PPSSPP Atrac::RemainingFrames (AtracCtx.cpp:639): ALL_DATA_LOADED →
  // PSP_ATRAC_ALLDATA_IS_ON_MEMORY (-1); otherwise frames left in the buffer.
  kernel.register(ATRAC.sceAtracGetRemainFrame, (regs, bus) => {
    const ctx = atracContexts.get(regs.getGpr(4));
    if (!ctx) { regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID); return; }
    const remain = ctx.status === AtracStatus.ALL_DATA_LOADED
      ? (-1 >>> 0)
      : (ctx.decodedPcm === null
          ? 1
          : Math.max(0, Math.ceil((ctx.info.totalSamples - ctx.decodePos) / ctx.info.samplesPerFrame)));
    const addr = regs.getGpr(5);
    if (addr !== 0) bus.writeU32(addr, remain);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetSoundSample(id, endSamplePtr, loopStartPtr, loopEndPtr) ────
  // PPSSPP NID 0xa2bba8be — canonical
  kernel.register(ATRAC.sceAtracGetSoundSample, (regs, bus) => {
    const ctx = atracContexts.get(regs.getGpr(4));
    const endSample = ctx?.info.totalSamples ?? 0xFFFFFFFF;
    const loopS = (ctx?.info.loopStart ?? -1) >>> 0;
    const loopE = (ctx?.info.loopEnd   ?? -1) >>> 0;
    const ep = regs.getGpr(5); if (ep !== 0) bus.writeU32(ep, endSample);
    const sp = regs.getGpr(6); if (sp !== 0) bus.writeU32(sp, loopS);
    const lp = regs.getGpr(7); if (lp !== 0) bus.writeU32(lp, loopE);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetNextDecodePosition(id, posPtr) ────────────────────────────
  kernel.register(ATRAC.sceAtracGetNextDecodePosition, (regs, bus) => {
    const p = regs.getGpr(5);
    if (p !== 0) bus.writeU32(p, atracContexts.get(regs.getGpr(4))?.decodePos ?? 0);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetChannel(id, channelsPtr) ──────────────────────────────────
  kernel.register(ATRAC.sceAtracGetChannel, (regs, bus) => {
    const p = regs.getGpr(5);
    if (p !== 0) bus.writeU32(p, atracContexts.get(regs.getGpr(4))?.info.channels ?? 2);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetInternalErrorInfo(id, outPtr) — NID 0xe88f759b (PPSSPP canonical)
  kernel.register(ATRAC.sceAtracGetInternalErrorInfo, (regs, bus) => {
    const p = regs.getGpr(5);
    if (p !== 0) bus.writeU32(p, 0);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetBitrate(id, bitratePtr) ───────────────────────────────────
  kernel.register(ATRAC.sceAtracGetBitrate, (regs, bus) => {
    const p = regs.getGpr(5); if (p !== 0) bus.writeU32(p, 132);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetLoopStatus(id, loopNumPtr, statusPtr) ─────────────────────
  kernel.register(ATRAC.sceAtracGetLoopStatus, (regs, bus) => {
    const ctx = atracContexts.get(regs.getGpr(4));
    const lp = regs.getGpr(5); if (lp !== 0) bus.writeU32(lp, (ctx?.loopNum ?? 0) >>> 0);
    const sp = regs.getGpr(6); if (sp !== 0) bus.writeU32(sp, 0);
    regs.setGpr(2, 0);
  });

  // ── sceAtracSetLoopNum(id, loopNum) ──────────────────────────────────────
  // PPSSPP Atrac::SetLoopNum (AtracCtx.cpp:827): errors with
  // NO_LOOP_INFORMATION when the track has no loop points, else stores loopNum
  // (-1 = loop forever, N > 0 = loop N times).
  kernel.register(ATRAC.sceAtracSetLoopNum, (regs) => {
    const ctx = atracContexts.get(regs.getGpr(4));
    if (!ctx) { regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID); return; }
    const hasLoop = ctx.info.loopStart >= 0 && ctx.info.loopEnd > ctx.info.loopStart;
    if (!hasLoop) {
      regs.setGpr(2, 0x80630021); // SCE_ERROR_ATRAC_NO_LOOP_INFORMATION
      return;
    }
    ctx.loopNum = regs.getGpr(5) | 0;
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetSecondBufferInfo ──────────────────────────────────────────
  kernel.register(ATRAC.sceAtracGetSecondBufferInfo, (regs, bus) => {
    const fp = regs.getGpr(5); if (fp !== 0) bus.writeU32(fp, 0);
    const dp = regs.getGpr(6); if (dp !== 0) bus.writeU32(dp, 0);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetOutputChannel(id, outPtr) ─────────────────────────────────
  kernel.register(ATRAC.sceAtracGetOutputChannel, (regs, bus) => {
    const p = regs.getGpr(5); if (p !== 0) bus.writeU32(p, 2);
    regs.setGpr(2, 0);
  });

  // ── sceAtracReleaseAtracID(id) ───────────────────────────────────────────
  // Real release: delete the context and return the slot to the free pool.
  // PPSSPP: UnregisterAndDeleteAtrac() — deletes immediately, id returns to pool.
  kernel.register(ATRAC.sceAtracReleaseAtracID, (regs) => {
    const id = regs.getGpr(4);
    if (id >= 0 && id < MAX_ATRAC_IDS && atracContexts.has(id)) {
      atracContexts.delete(id);
      atracDecodeCallCount.delete(id);
      log.debug(`sceAtracReleaseAtracID(${id})`);
      regs.setGpr(2, 0);
    } else {
      log.warn(`sceAtracReleaseAtracID(${id}): bad or already-freed id`);
      regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID);
    }
  });

  // ── sceAtracGetAtracID (NID 0x780f88d1) ─────────────────────────────────
  kernel.register(ATRAC.sceAtracGetAtracID, (regs) => {
    const codecType = regs.getGpr(4);
    if (codecType !== PSP_CODEC_AT3 && codecType !== PSP_CODEC_AT3PLUS) {
      regs.setGpr(2, SCE_ERROR_ATRAC_INVALID_CODECTYPE);
      return;
    }
    const id = allocAtracID(codecType);
    if (id < 0) {
      regs.setGpr(2, SCE_ERROR_ATRAC_NO_ATRACID);
      return;
    }
    atracContexts.set(id, {
      id,
      info: {
        codecType: codecType === PSP_CODEC_AT3 ? "AT3" : "AT3PLUS",
        totalSamples: 0, loopStart: -1, loopEnd: -1,
        channels: 2, sampleRate: 44100,
        samplesPerFrame: codecType === PSP_CODEC_AT3PLUS ? 2048 : 1024,
      },
      decodedPcm: null, decodePos: 0, decoding: false, released: false, loopNum: 0,
      bufPtr: 0, bufSize: 0,
      status: AtracStatus.LOW_LEVEL,
      codecType,
    });
    log.debug(`sceAtracGetAtracID: codecType=0x${codecType.toString(16)} → id=${id}`);
    regs.setGpr(2, id);
  });

  // ── sceAtracGetStreamDataInfo(id, writePtrAddr, writableBytesAddr, readOffsetAddr) ──
  // PPSSPP NID 0x5d268707
  kernel.register(ATRAC.sceAtracGetStreamDataInfo, (regs, bus) => {
    const writeP  = regs.getGpr(5); if (writeP  !== 0) bus.writeU32(writeP, 0);
    const writeSz = regs.getGpr(6); if (writeSz !== 0) bus.writeU32(writeSz, 0);
    const rdOff   = regs.getGpr(7); if (rdOff   !== 0) bus.writeU32(rdOff, 0);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetBufferInfoForResetting(id, sample, bufferInfoAddr) ─────────
  // PPSSPP NID 0x2dd3e298
  kernel.register(ATRAC.sceAtracGetBufferInfoForResetting, (regs, bus) => {
    const bufInfoAddr = regs.getGpr(6);
    if (bufInfoAddr !== 0) bus.writeBytes(bufInfoAddr, new Uint8Array(16));
    regs.setGpr(2, 0);
  });

  // ── sceAtracAddStreamData(id, bytesAdded) — NID 0x7db31251 ───────────────
  // Called when the game has written more compressed AT3 data into the ring
  // buffer set up by sceAtracSetHalfwayBufferAndGetID.  Re-read and decode.
  kernel.register(ATRAC.sceAtracAddStreamData, (regs, bus) => {
    const id         = regs.getGpr(4);
    const bytesAdded = regs.getGpr(5);
    const ctx = atracContexts.get(id);
    if (!ctx || ctx.bufPtr === 0) { regs.setGpr(2, 0); return; }
    if (ctx.status === AtracStatus.ALL_DATA_LOADED) {
      if (bytesAdded !== 0) log.warn(`sceAtracAddStreamData id=${id}: ALL_DATA_LOADED`);
      regs.setGpr(2, SCE_ERROR_ATRAC_ALL_DATA_LOADED);
      return;
    }
    log.info(`sceAtracAddStreamData id=${id} bytesAdded=${bytesAdded} — re-reading buffer`);
    // Re-read the full buffer from PSP RAM (game has now filled it)
    const data = bus.readBytes(ctx.bufPtr, ctx.bufSize || bytesAdded);
    beginAtracDecode(id, data, ctx.bufPtr, ctx.bufSize, ctx.status, ctx.codecType);
    regs.setGpr(2, 0);
  });

  // ── sceAtracSetData (update existing context fully) NID 0x0e2a73ab ───────
  kernel.register(ATRAC.sceAtracSetData, (regs, bus) => {
    const id  = regs.getGpr(4);
    const ptr = regs.getGpr(5);
    const sz  = regs.getGpr(6) >>> 0;
    const ctx = atracContexts.get(id);
    if (!ctx) { regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID); return; }
    beginAtracDecode(id, bus.readBytes(ptr, sz), ptr, sz, AtracStatus.ALL_DATA_LOADED, ctx.codecType);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetNextSample (NID 0x36faabfb) ───────────────────────────────
  kernel.register(ATRAC.sceAtracGetNextSample, (regs, bus) => {
    const p = regs.getGpr(5);
    const ctx = atracContexts.get(regs.getGpr(4));
    if (p !== 0) bus.writeU32(p, ctx?.info.samplesPerFrame ?? 512);
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetMaxSample (NID 0xd6a5f2f7) ────────────────────────────────
  kernel.register(ATRAC.sceAtracGetMaxSample, (regs, bus) => {
    const p = regs.getGpr(5);
    const ctx = atracContexts.get(regs.getGpr(4));
    if (p !== 0) bus.writeU32(p, ctx?.info.samplesPerFrame ?? 512);
    regs.setGpr(2, 0);
  });

  // ── sceAtracReinit(at3Count, at3plusCount) — PPSSPP sceAtrac.cpp:794-832 ──
  kernel.register(ATRAC.sceAtracReinit, (regs) => {
    const at3Count = regs.getGpr(4) | 0;
    const at3plusCount = regs.getGpr(5) | 0;

    // PPSSPP: fail if any IDs still in use
    for (let i = 0; i < MAX_ATRAC_IDS; i++) {
      if (atracContexts.has(i)) {
        log.warn(`sceAtracReinit: ID ${i} still in use — returning BUSY`);
        regs.setGpr(2, 0x80020001); // SCE_KERNEL_ERROR_BUSY
        return;
      }
    }

    // Reset slot types
    atracContextTypes.fill(0);
    let next = 0;
    const space = MAX_ATRAC_IDS;

    // (0,0) = deinit
    if (at3Count === 0 && at3plusCount === 0) {
      log.info("sceAtracReinit: deinit");
      regs.setGpr(2, 0);
      return;
    }

    // AT3+ slots cost double in PPSSPP
    for (let i = 0; i < at3plusCount && next < space - 1; i++) {
      atracContextTypes[next++] = PSP_CODEC_AT3PLUS;
      atracContextTypes[next++] = PSP_CODEC_AT3PLUS;
    }
    // AT3 slots
    for (let i = 0; i < at3Count && next < space; i++) {
      atracContextTypes[next++] = PSP_CODEC_AT3;
    }

    log.info(`sceAtracReinit: at3=${at3Count} at3plus=${at3plusCount} → types=[${atracContextTypes.join(",")}]`);
    regs.setGpr(2, 0);
  });

  // ── sceAtracResetPlayPosition (NID 0x644e5607) ────────────────────────────
  kernel.register(ATRAC.sceAtracResetPlayPosition, (regs) => {
    const id     = regs.getGpr(4);
    const sample = regs.getGpr(5);
    const ctx    = atracContexts.get(id);
    if (ctx) {
      ctx.decodePos = Math.min(sample, ctx.info.totalSamples > 0 ? ctx.info.totalSamples : sample);
      log.debug(`sceAtracResetPlayPosition id=${id} → decodePos=${ctx.decodePos}`);
    }
    regs.setGpr(2, 0);
  });

  // ── sceAtracGetBufferInfoForReseting (PPSSPP alternate spelling) NID 0xca3ca3d2
  kernel.register(ATRAC.sceAtracGetBufferInfoForReseting, (regs, bus) => {
    const bufInfoAddr = regs.getGpr(6);
    if (bufInfoAddr !== 0) bus.writeBytes(bufInfoAddr, new Uint8Array(16));
    regs.setGpr(2, 0);
  });

  // ── sceAtracSetHalfwayBuffer (update existing context) NID 0x3f6e26b5 ────
  kernel.register(ATRAC.sceAtracSetHalfwayBuffer, (regs, bus) => {
    const id       = regs.getGpr(4);
    const ptr      = regs.getGpr(5);
    const readSize = regs.getGpr(6) >>> 0;
    const bSize    = regs.getGpr(7) >>> 0;
    if (readSize > bSize) { regs.setGpr(2, SCE_ERROR_ATRAC_INCORRECT_READ_SIZE); return; }
    const ctx = atracContexts.get(id);
    if (!ctx) { regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID); return; }
    beginAtracDecode(id, bus.readBytes(ptr, readSize), ptr, bSize, AtracStatus.HALFWAY_BUFFER, ctx.codecType);
    regs.setGpr(2, 0);
  });

  // ── sceAtracIsSecondBufferNeeded(id) ─────────────────────────────────────
  // PPSSPP sceAtrac.cpp:851 — AtracValidateManaged first, then returns 1 only
  // when the buffer state is STREAMED_LOOP_WITH_TRAILER (a second buffer holds
  // the loop tail). Our HLE buffers the whole stream (ALL_DATA_LOADED), so this
  // is normally 0. Returns true whether or not a second buffer is already set.
  kernel.register(ATRAC.sceAtracIsSecondBufferNeeded, (regs) => {
    const ctx = atracContexts.get(regs.getGpr(4));
    // AtracValidateManaged (sceAtrac.cpp:280)
    if (!ctx) { regs.setGpr(2, SCE_ERROR_ATRAC_BAD_ATRACID); return; }
    if (ctx.status === AtracStatus.NO_DATA)   { regs.setGpr(2, SCE_ERROR_ATRAC_NO_DATA); return; }
    if (ctx.status === AtracStatus.LOW_LEVEL) { regs.setGpr(2, SCE_ERROR_ATRAC_IS_LOW_LEVEL); return; }
    if (ctx.status === AtracStatus.FOR_SCESAS){ regs.setGpr(2, SCE_ERROR_ATRAC_IS_FOR_SCESAS); return; }
    regs.setGpr(2, ctx.status === AtracStatus.STREAMED_LOOP_WITH_TRAILER ? 1 : 0);
  });

  // ── Stubs: ATRAC ──────────────────────────────────────────────────────────
  kernel.stub(ATRAC._sceAtracGetContextAddress, 1);
  kernel.stub(ATRAC.sceAtracLowLevelDecode);
  kernel.stub(ATRAC.sceAtracLowLevelInitDecoder);
  kernel.stub(ATRAC.sceAtracReleaseResources);
  kernel.stub(ATRAC.sceAtracSetAA3DataAndGetID);
  kernel.stub(ATRAC.sceAtracSetAA3HalfwayBufferAndGetID);
  kernel.stub(ATRAC.sceAtracSetMOutData);
  kernel.stub(ATRAC.sceAtracSetMOutDataAndGetID);
  kernel.stub(ATRAC.sceAtracSetMOutHalfwayBuffer);
  kernel.stub(ATRAC.sceAtracSetMOutHalfwayBufferAndGetID);
  kernel.stub(ATRAC.sceAtracSetSecondBuffer);
  kernel.stub(ATRAC.sceAtracStartEntry);
  // ── Stubs: AUDIO ──────────────────────────────────────────────────────────
  kernel.stub(AUDIO.sceAudioEnd);
  kernel.stub(AUDIO.sceAudioGetInputLength);
  kernel.stub(AUDIO.sceAudioInit);
  kernel.stub(AUDIO.sceAudioInput);
  kernel.stub(AUDIO.sceAudioInputBlocking);
  kernel.stub(AUDIO.sceAudioInputInit, 1);
  kernel.stub(AUDIO.sceAudioInputInitEx, 1);
  kernel.stub(AUDIO.sceAudioLoopbackTest);
  kernel.stub(AUDIO.sceAudioOneshotOutput);
  kernel.stub(AUDIO.sceAudioOutput2ChangeLength);
  kernel.stub(AUDIO.sceAudioPollInputEnd);
  kernel.stub(AUDIO.sceAudioRoutingGetMode);
  kernel.stub(AUDIO.sceAudioRoutingGetVolumeMode);
  kernel.stub(AUDIO.sceAudioRoutingSetMode);
  kernel.stub(AUDIO.sceAudioRoutingSetVolumeMode);
  kernel.stub(AUDIO.sceAudioSetFrequency);
  kernel.stub(AUDIO.sceAudioSetVolumeOffset);
  kernel.stub(AUDIO.sceAudioWaitInputEnd);

  // ── AAC ──────────────────────────────────────────────────────────
  kernel.stub(AAC.sceAacCheckStreamDataNeeded);
  kernel.stub(AAC.sceAacDecode);
  kernel.stub(AAC.sceAacExit);
  kernel.stub(AAC.sceAacGetInfoToAddStreamData, 1);
  kernel.stub(AAC.sceAacGetLoopNum);
  kernel.stub(AAC.sceAacGetMaxOutputSample);
  kernel.stub(AAC.sceAacGetSumDecodedSample);
  kernel.stub(AAC.sceAacInit, 1);
  kernel.stub(AAC.sceAacInitResource, 1);
  kernel.stub(AAC.sceAacNotifyAddStreamData, 1);
  kernel.stub(AAC.sceAacResetPlayPosition);
  kernel.stub(AAC.sceAacSetLoopNum);
  kernel.stub(AAC.sceAacTermResource);
  // ── AUDIOCODEC — PPSSPP sceAudiocodec.cpp ─────────────────────────────
  // SceAudiocodecCodec struct layout (128 bytes, from sceAudiocodec.h):
  //   0x00: unk_init (s32) — firmware version indicator (0x5100601)
  //   0x04: unk4 (s32)
  //   0x08: err (s32)
  //   0x0C: edramAddr (s32)
  //   0x10: neededMem (s32)
  //   0x14: inited (s32)
  //   0x18: inBuf (u32) — pointer to input compressed data
  //   0x1C: srcBytesRead (s32) — bytes consumed from input
  //   0x20: outBuf (u32) — pointer to output PCM buffer
  //   0x24: dstSamplesWritten (s32) — samples written to output
  //   0x28: unk40/formatOutSamples (union)
  //   0x38: mp3_9999 (s32)
  //   0x3C: mp3_3 (s32)
  //   0x40: unk64 (s32) — AT3+ size related
  //   0x44: mp3_9 (s32)
  //   0x48: mp3_0 (s32)
  //   0x50: mp3_1_first (s32)
  //   0x58: mp3_1 (s32)
  //   0x68: allocMem (u32)

  // sceAudiocodecCheckNeedMem(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:302-338
  kernel.register(AUDIOCODEC.sceAudiocodecCheckNeedMem, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    if (codec < 0x1000 || codec >= 0x1006) {
      regs.setGpr(2, 0x80000025); // SCE_KERNEL_ERROR_BAD_ARGUMENT
      return;
    }
    let neededMem = 0x3de0;
    switch (codec) {
      case 0x1000: neededMem = 0x7bc0; break; // AT3+
      case 0x1001: neededMem = 0x3de0; break; // AT3
      case 0x1002: neededMem = 0x3b68; break; // MP3
      case 0x1003: neededMem = 0x18f20; break; // AAC
    }
    bus.writeU32(ctxPtr + 0x10, neededMem);  // neededMem
    bus.writeU32(ctxPtr + 0x08, 0);          // err = 0
    bus.writeU32(ctxPtr + 0x00, 0x5100601);  // unk_init
    regs.setGpr(2, 0);
  });

  // sceAudiocodecGetEDRAM(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:340-354
  kernel.register(AUDIOCODEC.sceAudiocodecGetEDRAM, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    let allocMem = 0x0018ea90;
    if (codec === 0x1002) allocMem = 0x001B3124; // MP3
    bus.writeU32(ctxPtr + 0x68, allocMem);                     // allocMem
    bus.writeU32(ctxPtr + 0x0C, (allocMem + 0x3f) & ~0x3f);   // edramAddr (aligned)
    regs.setGpr(2, 0);
  });

  // sceAudiocodecReleaseEDRAM(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:356-361
  kernel.register(AUDIOCODEC.sceAudiocodecReleaseEDRAM, (regs) => {
    const ctxPtr = regs.getGpr(4);
    audiocodecContexts.delete(ctxPtr);
    regs.setGpr(2, 0);
  });

  // Per-context decoder state for sceAudiocodec
  interface AudiocodecCtx {
    codec: number;
    channels: number;
    sampleRate: number;
    mp3Accum: Mp3FrameAccumulator | null;
  }
  const audiocodecContexts = new Map<number, AudiocodecCtx>();

  function initAudiocodecCtx(ctxPtr: number, codec: number): void {
    const existing = audiocodecContexts.get(ctxPtr);
    if (existing) audiocodecContexts.delete(ctxPtr);
    audiocodecContexts.set(ctxPtr, {
      codec,
      channels: 2,
      sampleRate: 44100,
      mp3Accum: codec === 0x1002 ? new Mp3FrameAccumulator(3) : null,
    });
  }

  // sceAudiocodecInit(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:133-199
  kernel.register(AUDIOCODEC.sceAudiocodecInit, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    bus.writeU32(ctxPtr + 0x00, 0x5100601);  // unk_init
    bus.writeU32(ctxPtr + 0x08, 0);          // err = 0
    if (codec === 0x1002) bus.writeU32(ctxPtr + 0x38, 9999); // mp3_9999
    initAudiocodecCtx(ctxPtr, codec);
    regs.setGpr(2, 0);
  });

  // sceAudiocodecInitMono(ctxPtr, codec) — same as Init
  kernel.register(AUDIOCODEC.sceAudiocodecInitMono, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    bus.writeU32(ctxPtr + 0x00, 0x5100601);
    bus.writeU32(ctxPtr + 0x08, 0);
    initAudiocodecCtx(ctxPtr, codec);
    regs.setGpr(2, 0);
  });

  // sceAudiocodecGetInfo(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:275-300
  kernel.register(AUDIOCODEC.sceAudiocodecGetInfo, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    if (codec === 0x1002) {
      // MP3: write expected response fields (offsets from SceAudiocodecCodec struct)
      bus.writeU32(ctxPtr + 0x3C, 3);  // mp3_3 (offset 60)
      bus.writeU32(ctxPtr + 0x44, 9);  // mp3_9 (offset 68)
      bus.writeU32(ctxPtr + 0x48, 0);  // mp3_0 (offset 72)
      bus.writeU32(ctxPtr + 0x60, 1);  // mp3_1 (offset 96)
      bus.writeU32(ctxPtr + 0x54, 1);  // mp3_1_first (offset 84)
    }
    regs.setGpr(2, 0);
  });

  // sceAudiocodecGetOutputBytes(ctxPtr, codec, outBytesAddr) — PPSSPP sceAudiocodec.cpp:363-380
  kernel.register(AUDIOCODEC.sceAudiocodecGetOutputBytes, (regs, bus) => {
    const codec = regs.getGpr(5);
    const outAddr = regs.getGpr(6);
    let bytes = 0;
    switch (codec) {
      case 0x1000: bytes = 0x2000; break; // AT3+
      case 0x1001: bytes = 0x1000; break; // AT3
      case 0x1002: bytes = 0x1200; break; // MP3
    }
    if (outAddr !== 0) bus.writeU32(outAddr, bytes);
    regs.setGpr(2, 0);
  });

  // sceAudiocodecDecode(ctxPtr, codec) — PPSSPP sceAudiocodec.cpp:205-271
  // Decodes one compressed frame to PCM. Blocks thread during async decode.
  kernel.register(AUDIOCODEC.sceAudiocodecDecode, (regs, bus) => {
    const ctxPtr = regs.getGpr(4);
    const codec = regs.getGpr(5);
    const inBuf = bus.readU32(ctxPtr + 0x18);
    const outBuf = bus.readU32(ctxPtr + 0x20);

    // Determine frame size
    let bytesPerFrame = bus.readU32(ctxPtr + 0x1C); // srcBytesRead (game sets this for MP3/AAC)
    if (codec === 0x1000) {
      // AT3+: unk41 * 8 + 8
      const unk41 = bus.readU8(ctxPtr + 0x29);
      bytesPerFrame = unk41 * 8 + 8;
    } else if (codec === 0x1001) {
      bytesPerFrame = 384; // AT3 fixed
    }
    if (bytesPerFrame <= 0 || bytesPerFrame > 0x10000) bytesPerFrame = 384;

    // Default output sizes per codec (samples written to outBuf)
    let outSamples = 1024;
    switch (codec) {
      case 0x1000: outSamples = 2048; break; // AT3+ = 2048 samples
      case 0x1001: outSamples = 1024; break; // AT3 = 1024 samples
      case 0x1002: outSamples = 1152; break; // MP3 = 1152 samples
      case 0x1003: outSamples = 1024; break; // AAC
    }

    // Read compressed frame from PSP RAM
    const frameData = bus.readBytes(inBuf, bytesPerFrame);
    const actx = audiocodecContexts.get(ctxPtr);
    const channels = actx?.channels ?? 2;
    const sampleRate = actx?.sampleRate ?? 44100;

    // For MP3: use frame accumulator for bit reservoir handling
    const decodePromise: Promise<Int16Array | null> =
      codec === 0x1002 && actx?.mp3Accum
        ? (actx.mp3Accum.addFrame(frameData), actx.mp3Accum.decode())
        : decodeAudioFrame(frameData, codec, channels, sampleRate);

    // Block the current thread, decode async, wake with results
    let decodedPcm: Int16Array | null = null;
    const tid = kernel.currentThreadId;

    kernel.blockAtracDecode(regs, () => {
      // Wake callback: write PCM to PSP RAM
      if (decodedPcm && outBuf !== 0) {
        const writeBytes = Math.min(decodedPcm.byteLength, outSamples * 2 * channels);
        const pcmBytes = new Uint8Array(decodedPcm.buffer, decodedPcm.byteOffset, writeBytes);
        bus.writeBytes(outBuf, pcmBytes);
        bus.writeU32(ctxPtr + 0x1C, bytesPerFrame);
        bus.writeU32(ctxPtr + 0x24, writeBytes / (2 * channels));
      } else {
        // Decode failed — write silence, set err = 0x20b (PPSSPP sceAudiocodec.cpp:263)
        const silenceBytes = outSamples * 2 * channels;
        if (outBuf !== 0) {
          for (let i = 0; i < silenceBytes; i += 4) bus.writeU32(outBuf + i, 0);
        }
        bus.writeU32(ctxPtr + 0x08, 0x20b);  // err field
        bus.writeU32(ctxPtr + 0x1C, bytesPerFrame);
        bus.writeU32(ctxPtr + 0x24, outSamples);
      }
    });

    decodePromise.then(pcm => {
      decodedPcm = pcm;
      kernel.pendingAtracWakes.add(tid);
    }).catch(() => {
      kernel.pendingAtracWakes.add(tid);
    });
  });
  // ── VAUDIO ──────────────────────────────────────────────────────────
  kernel.stub(VAUDIO.sceVaudioChReserve, 1);
  kernel.stub(VAUDIO.sceVaudioChReserveBuffering, 1);
  kernel.stub(VAUDIO.sceVaudioOutputBlocking);
  kernel.stub(VAUDIO.sceVaudioSetAlcMode);
  kernel.stub(VAUDIO.sceVaudioSetEffectType);
  kernel.stub(VAUDIO.sceVaudioChRelease);
  kernel.stub(VAUDIO.sceVaudio_504E4745);
  kernel.stub(VAUDIO.sceVaudio_E8E78DC8);
  // ── MP3 ──────────────────────────────────────────────────────────
  kernel.stub(MP3.sceMp3CheckStreamDataNeeded);
  kernel.stub(MP3.sceMp3Decode);
  kernel.stub(MP3.sceMp3EndEntry);
  kernel.stub(MP3.sceMp3GetBitRate);
  kernel.stub(MP3.sceMp3GetFrameNum);
  kernel.stub(MP3.sceMp3GetInfoToAddStreamData, 1);
  kernel.stub(MP3.sceMp3GetLoopNum);
  kernel.stub(MP3.sceMp3GetMPEGVersion);
  kernel.stub(MP3.sceMp3GetMaxOutputSample);
  kernel.stub(MP3.sceMp3GetMp3ChannelNum);
  kernel.stub(MP3.sceMp3GetSamplingRate);
  kernel.stub(MP3.sceMp3GetSumDecodedSample);
  kernel.stub(MP3.sceMp3Init, 1);
  kernel.stub(MP3.sceMp3InitResource, 1);
  kernel.stub(MP3.sceMp3LowLevelDecode);
  kernel.stub(MP3.sceMp3LowLevelInit, 1);
  kernel.stub(MP3.sceMp3NotifyAddStreamData, 1);
  kernel.stub(MP3.sceMp3ReleaseMp3Handle);
  kernel.stub(MP3.sceMp3ReserveMp3Handle, 1);
  kernel.stub(MP3.sceMp3ResetPlayPosition);
  kernel.stub(MP3.sceMp3ResetPlayPositionByFrame);
  kernel.stub(MP3.sceMp3SetLoopNum);
  kernel.stub(MP3.sceMp3StartEntry, 1);
  kernel.stub(MP3.sceMp3TermResource);
  // ── MP4 ──────────────────────────────────────────────────────────
  kernel.stub(MP4.mp4msv_3C2183C7);
  kernel.stub(MP4.mp4msv_9CA13D1A);
  kernel.stub(MP4.sceMp4AacDecode);
  kernel.stub(MP4.sceMp4AacDecodeExit);
  kernel.stub(MP4.sceMp4AacDecodeInit, 1);
  kernel.stub(MP4.sceMp4AacDecodeInitResource, 1);
  kernel.stub(MP4.sceMp4AacDecodeTermResource);
  kernel.stub(MP4.sceMp4Create, 1);
  kernel.stub(MP4.sceMp4Delete);
  kernel.stub(MP4.sceMp4Finish);
  kernel.stub(MP4.sceMp4GetAacAu);
  kernel.stub(MP4.sceMp4GetAacAuWithoutSampleBuf);
  kernel.stub(MP4.sceMp4GetAacTrackInfoData);
  kernel.stub(MP4.sceMp4GetAvcAu);
  kernel.stub(MP4.sceMp4GetAvcAuWithoutSampleBuf);
  kernel.stub(MP4.sceMp4GetAvcParamSet);
  kernel.stub(MP4.sceMp4GetAvcTrackInfoData);
  kernel.stub(MP4.sceMp4GetMetaData);
  kernel.stub(MP4.sceMp4GetMetaDataInfo);
  kernel.stub(MP4.sceMp4GetMovieInfo);
  kernel.stub(MP4.sceMp4GetNumberOfMetaData);
  kernel.stub(MP4.sceMp4GetNumberOfSpecificTrack);
  kernel.stub(MP4.sceMp4GetSampleInfo);
  kernel.stub(MP4.sceMp4GetSampleNum);
  kernel.stub(MP4.sceMp4GetSampleNumWithTimeStamp);
  kernel.stub(MP4.sceMp4GetTrackEditList);
  kernel.stub(MP4.sceMp4GetTrackNumOfEditList);
  kernel.stub(MP4.sceMp4Init, 1);
  kernel.stub(MP4.sceMp4InitAu, 1);
  kernel.stub(MP4.sceMp4PutSampleNum);
  kernel.stub(MP4.sceMp4RegistTrack);
  kernel.stub(MP4.sceMp4SearchSyncSampleNum);
  kernel.stub(MP4.sceMp4TrackSampleBufAvailableSize);
  kernel.stub(MP4.sceMp4TrackSampleBufConstruct);
  kernel.stub(MP4.sceMp4TrackSampleBufDestruct);
  kernel.stub(MP4.sceMp4TrackSampleBufFlush);
  kernel.stub(MP4.sceMp4TrackSampleBufPut);
  kernel.stub(MP4.sceMp4TrackSampleBufQueryMemSize);
  kernel.stub(MP4.sceMp4UnregistTrack);

  // Save-state: the ATRAC contexts (decodedPcm is an Int16Array, stored as
  // base64; everything else in AtracContext and AtracInfo is plain), the per-id
  // wait lists and counters, and the sceAudiocodec contexts. The mp3Accum field
  // is a live stateful decoder instance we can't serialize, so it's dropped on
  // save and rebuilt by the next decode (an in-flight mp3 frame restarts).
  kernel.registerStateModule("audio", {
    save() {
      return {
        atracContexts: [...atracContexts.entries()].map(([k, v]) => [k, {
          ...v,
          decodedPcm: v.decodedPcm ? int16ToB64(v.decodedPcm) : null,
        }]),
        atracContextTypes: atracContextTypes.slice(),
        atracWaiters: [...atracWaiters.entries()].map(([k, v]) => [k, v.slice()]),
        outputCallCount: [...outputCallCount.entries()],
        fakeNextCh,
        audiocodecContexts: [...audiocodecContexts.entries()].map(([k, v]) => [k, {
          codec: v.codec, channels: v.channels, sampleRate: v.sampleRate,
        }]),
      };
    },
    load(data) {
      const d = data as {
        atracContexts: [number, Omit<AtracContext, "decodedPcm"> & { decodedPcm: string | null }][];
        atracContextTypes: number[];
        atracWaiters: [number, number[]][];
        outputCallCount: [number, number][];
        fakeNextCh: number;
        audiocodecContexts: [number, { codec: number; channels: number; sampleRate: number }][];
      };
      atracContexts.clear();
      for (const [k, v] of d.atracContexts) {
        atracContexts.set(k, {
          ...v,
          decodedPcm: v.decodedPcm !== null ? b64ToInt16(v.decodedPcm) : null,
        });
      }
      atracContextTypes.length = 0;
      atracContextTypes.push(...d.atracContextTypes);
      atracWaiters.clear();
      for (const [k, v] of d.atracWaiters) atracWaiters.set(k, v.slice());
      outputCallCount.clear();
      for (const [k, v] of d.outputCallCount) outputCallCount.set(k, v);
      fakeNextCh = d.fakeNextCh;
      audiocodecContexts.clear();
      for (const [k, v] of d.audiocodecContexts) {
        audiocodecContexts.set(k, { ...v, mp3Accum: null });
      }
    },
  });

  log.info("Audio HLE handlers registered");
}
