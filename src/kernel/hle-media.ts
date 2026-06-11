/**
 * HLE media stub handlers for sceSas, scePsmf, sceRtc.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { SAS, PSMF, RTC, VTIMER, DEFLT, G729, CCC, JPEG, P3DA, REG } from "./nids.js";
import { lookupCategory, REG_TYPE_DIR, REG_TYPE_INT, REG_TYPE_STR, REG_TYPE_BIN, SCE_REG_ERROR_CATEGORY_NOT_FOUND } from "./psp-registry.js";

const log = Logger.get("HLE-MEDIA");

export function registerMediaHLE(kernel: HLEKernel): void {

  let sasGrainSize = 256;

  // ── sceSas ──────────────────────────────────────────────────────────────

  // __sceSasInit(core, grainSize, maxVoices, outputMode, sampleRate)
  // PPSSPP sceSas.cpp:213-250: validates core addr (64-byte aligned, valid RAM),
  // grainSize (0x40-0x800, 32-byte aligned), maxVoices (1-32), outputMode (0-1), sampleRate (44100)
  kernel.register(SAS.__sceSasInit, (regs) => {
    const core = regs.getGpr(4);
    const grainSize = regs.getGpr(5);
    const maxVoices = regs.getGpr(6);
    const outputMode = regs.getGpr(7);
    const sampleRate = regs.getGpr(8);
    // PPSSPP sceSas.cpp:214: Memory::IsValidAddress(core) + alignment
    if (core < 0x08000000 || core >= 0x0C000000 || (core & 0x3F) !== 0) {
      log.warn(`__sceSasInit: bad core addr 0x${core.toString(16)}`);
      regs.setGpr(2, 0x80260001); // SCE_SAS_ERROR_BAD_ADDRESS
      return;
    }
    if (maxVoices === 0 || maxVoices > 32) {
      regs.setGpr(2, 0x80260003); return; // SCE_SAS_ERROR_INVALID_MAX_VOICES
    }
    if (grainSize < 0x40 || grainSize > 0x800 || (grainSize & 0x1F) !== 0) {
      regs.setGpr(2, 0x80260005); return; // SCE_SAS_ERROR_INVALID_GRAIN
    }
    if (outputMode !== 0 && outputMode !== 1) {
      regs.setGpr(2, 0x80260004); return; // SCE_SAS_ERROR_INVALID_OUTPUT_MODE
    }
    if (sampleRate !== 44100) {
      regs.setGpr(2, 0x80260008); return; // SCE_SAS_ERROR_INVALID_SAMPLE_RATE
    }
    sasGrainSize = grainSize;
    log.info(`__sceSasInit: core=0x${core.toString(16)} grain=${grainSize} voices=${maxVoices} mode=${outputMode} rate=${sampleRate}`);
    regs.setGpr(2, 0);
  });

  // __sceSasCore(core, outAddr) — synthesize one grain of audio
  // We don't emulate SAS voices, so write silence to outAddr.
  // Games read from outAddr after this call and feed it to sceAudioOutput.
  kernel.register(SAS.__sceSasCore, (regs, bus) => {
    const outAddr = regs.getGpr(5);
    if (outAddr !== 0) {
      // Stereo s16 silence: 4 bytes per frame × grainSize frames
      for (let i = 0; i < sasGrainSize * 4; i++) bus.writeU8(outAddr + i, 0);
    }
    regs.setGpr(2, 0);
    kernel.blockForAudio(regs, sasGrainSize, 44_100);
  });

  // __sceSasCoreWithMix — mix into existing buffer (additive)
  // Since we have no voices, mixing nothing doesn't change the buffer.
  kernel.register(SAS.__sceSasCoreWithMix, (regs) => {
    regs.setGpr(2, 0);
    kernel.blockForAudio(regs, sasGrainSize, 44_100);
  });

  // __sceSasGetGrain / __sceSasSetGrain
  kernel.register(SAS.__sceSasGetGrain,              (regs) => { regs.setGpr(2, sasGrainSize); });
  kernel.register(SAS.__sceSasSetGrain,              (regs) => { sasGrainSize = regs.getGpr(5) || 256; regs.setGpr(2, 0); });

  // __sceSasGetEndFlag — return 0xFFFFFFFF (all voices ended, we don't emulate SAS voices)
  kernel.register(SAS.__sceSasGetEndFlag, (regs) => {
    regs.setGpr(2, 0xFFFFFFFF);
  });

  // __sceSasRevType(core, type) — set reverb type, return 0
  kernel.register(SAS.__sceSasRevType, (regs) => {
    regs.setGpr(2, 0);
  });

  // __sceSasRevVON(core, dry, wet) — set reverb voice on, return 0
  kernel.register(SAS.__sceSasRevVON, (regs) => {
    regs.setGpr(2, 0);
  });

  // __sceSasRevEVOL(core, lv, rv) — set reverb effect volume, return 0
  kernel.register(SAS.__sceSasRevEVOL, (regs) => {
    regs.setGpr(2, 0);
  });

  // __sceSasRevParam(core, delay, feedback) — set reverb params, return 0
  // PPSSPP sceSas.cpp:638
  kernel.register(SAS.__sceSasRevParam, (regs) => {
    regs.setGpr(2, 0);
  });

  // __sceSasGetOutputmode(core) — return 0 (PSP_SAS_OUTPUTMODE_MIXED)
  // PPSSPP sceSas.cpp:651
  kernel.register(SAS.__sceSasGetOutputmode, (regs) => {
    regs.setGpr(2, 0); // PSP_SAS_OUTPUTMODE_MIXED
  });

  // Remaining sceSas stubs
  kernel.stub(SAS.__sceSasSetOutputmode);
  kernel.stub(SAS.__sceSasSetADSR);
  kernel.stub(SAS.__sceSasSetADSRmode);
  kernel.stub(SAS.__sceSasSetSL);
  kernel.stub(SAS.__sceSasGetEnvelopeHeight);
  kernel.stub(SAS.__sceSasSetSimpleADSR);
  kernel.stub(SAS.__sceSasSetKeyOn);
  kernel.stub(SAS.__sceSasSetKeyOff);
  kernel.stub(SAS.__sceSasSetVoice);
  kernel.stub(SAS.__sceSasSetVolume);
  kernel.stub(SAS.__sceSasSetTrianglarWave);
  kernel.stub(SAS.__sceSasSetSteepWave);
  kernel.stub(SAS.__sceSasSetNoise);
  kernel.stub(SAS.__sceSasSetPause);
  kernel.stub(SAS.__sceSasGetPauseFlag);
  kernel.stub(SAS.__sceSasSetPitch);
  kernel.stub(SAS.__sceSasSetVoicePCM);
  kernel.stub(SAS.__sceSasSetVoiceATRAC3);
  kernel.stub(SAS.__sceSasConcatenateATRAC3);
  kernel.stub(SAS.__sceSasUnsetATRAC3);
  kernel.stub(SAS.__sceSasGetAllEnvelopeHeights);

  // ── sceRtc ───────────────────────────────────────────────────────────────

  /** Get emulated microseconds from CoreTiming, or 0 if CoreTiming unavailable. */
  function getEmulatedUsRtc(): number {
    const ct = kernel.coreTiming;
    return ct ? ct.cyclesToUs(ct.getTicks()) : 0;
  }

  // sceRtcGetCurrentTick(tick_ptr)
  kernel.register(RTC.sceRtcGetCurrentTick, (regs) => {
    const ptr = regs.getGpr(4);
    const us = BigInt(getEmulatedUsRtc());
    kernel.bus.writeU32(ptr, Number(us & 0xFFFFFFFFn));
    kernel.bus.writeU32(ptr + 4, Number((us >> 32n) & 0xFFFFFFFFn));
    regs.setGpr(2, 0);
  });

  // sceRtcGetTickResolution → 1000000 (microseconds)
  kernel.register(RTC.sceRtcGetTickResolution, (regs) => {
    regs.setGpr(2, 1000000);
  });

  // Helper: write little-endian u16
  function writeU16LE(bus: { writeU8(a: number, v: number): void }, ptr: number, v: number): void {
    bus.writeU8(ptr, v & 0xFF);
    bus.writeU8(ptr + 1, (v >> 8) & 0xFF);
  }

  // Helper: write ScePspDateTime struct (16 bytes) from a JS Date (UTC components)
  function writePspDateTimeUTC(bus: Parameters<Parameters<typeof kernel.register>[1]>[1], ptr: number, d: Date, microsecond: number): void {
    writeU16LE(bus, ptr + 0, d.getUTCFullYear());
    writeU16LE(bus, ptr + 2, d.getUTCMonth() + 1);
    writeU16LE(bus, ptr + 4, d.getUTCDate());
    writeU16LE(bus, ptr + 6, d.getUTCHours());
    writeU16LE(bus, ptr + 8, d.getUTCMinutes());
    writeU16LE(bus, ptr + 10, d.getUTCSeconds());
    bus.writeU32(ptr + 12, microsecond);
  }

  // sceRtcGetCurrentClock(pspTimePtr, tz) — PPSSPP sceRtc.cpp:298
  kernel.register(RTC.sceRtcGetCurrentClock, (regs, bus) => {
    const ptr = regs.getGpr(4);
    const tz = regs.getGpr(5) | 0; // timezone offset in minutes
    const emulatedUs = getEmulatedUsRtc();
    const baseMs = Date.now();
    const d = new Date(baseMs + tz * 60000);
    if (ptr >= 0x08000000 && ptr < 0x0C000000) {
      writePspDateTimeUTC(bus, ptr, d, emulatedUs % 1000000);
    }
    regs.setGpr(2, 0);
  });

  // sceRtcGetCurrentClockLocalTime(pspTimePtr) — PPSSPP sceRtc.cpp:324
  kernel.register(RTC.sceRtcGetCurrentClockLocalTime, (regs, bus) => {
    const ptr = regs.getGpr(4);
    const emulatedUs = getEmulatedUsRtc();
    const d = new Date(); // local time
    if (ptr >= 0x08000000 && ptr < 0x0C000000) {
      writeU16LE(bus, ptr + 0, d.getFullYear());
      writeU16LE(bus, ptr + 2, d.getMonth() + 1);
      writeU16LE(bus, ptr + 4, d.getDate());
      writeU16LE(bus, ptr + 6, d.getHours());
      writeU16LE(bus, ptr + 8, d.getMinutes());
      writeU16LE(bus, ptr + 10, d.getSeconds());
      bus.writeU32(ptr + 12, emulatedUs % 1000000);
    }
    regs.setGpr(2, 0);
  });

  // ── sceKernel VTimer (PPSSPP sceKernelVTimer.cpp) ────────────────────────

  interface VTimerState {
    active: number;       // 0 or 1
    base: number;         // global time (us) when started
    current: number;      // accumulated time (us) from previous runs
    schedule: number;     // handler fire time relative to base+current
    handlerAddr: number;  // guest handler function address
    commonAddr: number;   // user argument passed to handler
  }
  const vtimers = new Map<number, VTimerState>();

  const SCE_KERNEL_ERROR_UNKNOWN_VTID = 0x80020082;

  const getVTimerRunningTime = (vt: VTimerState): number => {
    if (!vt.active) return 0;
    return getGlobalTimeUs() - vt.base;
  };
  const getVTimerCurrentTime = (vt: VTimerState): number => {
    return vt.current + getVTimerRunningTime(vt);
  };
  const getGlobalTimeUs = (): number => {
    return kernel.coreTiming?.cyclesToUs(kernel.coreTiming.getTicks()) ?? 0;
  };
  const readU64 = (bus: typeof kernel.bus, addr: number): number => {
    const lo = bus.readU32(addr) >>> 0;
    const hi = bus.readU32(addr + 4) >>> 0;
    return hi * 0x100000000 + lo;
  };
  const writeU64 = (bus: typeof kernel.bus, addr: number, val: number): void => {
    bus.writeU32(addr, val & 0xFFFFFFFF);
    bus.writeU32(addr + 4, (val / 0x100000000) & 0xFFFFFFFF);
  };

  // BREAK trampoline for VTimer handler callbacks (same pattern as GE callbacks).
  // Placed at a fixed low-kernel address that doesn't conflict with GE trampoline (0x08000010).
  const VTIMER_TRAMPOLINE_ADDR = 0x08000020;
  let vtimerTrampolineWritten = false;
  // PPSSPP VTimerIntrHandler uses 48 bytes of stack for arguments
  const HANDLER_STACK_SPACE = 48;

  /**
   * Schedule a CoreTiming event for a VTimer's handler.
   * Mirrors PPSSPP __KernelScheduleVTimer (sceKernelVTimer.cpp:99-118).
   */
  const scheduleVTimer = (uid: number, vt: VTimerState, schedule: number): void => {
    const ct = kernel.coreTiming;
    if (!ct || vtimerEventId < 0) return;

    // Unschedule any pending event for this uid
    // (CoreTiming doesn't have per-userdata removal, so we track via the map)
    vt.schedule = schedule;

    if (vt.active === 1 && vt.handlerAddr !== 0) {
      if (schedule < 250) schedule = 250;
      const goalUs = vt.base + schedule - vt.current;
      const nowUs = getGlobalTimeUs();
      const minGoalUs = nowUs + 250;
      const delayUs = goalUs < minGoalUs ? 250 : goalUs - nowUs;
      ct.scheduleEvent(ct.usToCycles(delayUs), vtimerEventId, uid);
    }
  };

  /**
   * Invoke a VTimer's guest handler function using the mini-CPU-run pattern.
   * Mirrors PPSSPP VTimerIntrHandler::run (sceKernelVTimer.cpp:139-157).
   *
   * handler(uid, schedulePtr, currentTimePtr, commonAddr)
   * Schedule and currentTime are written to stack space borrowed from $sp.
   */
  const invokeVTimerHandler = (uid: number, vt: VTimerState): void => {
    const cpu = kernel.cpu;
    if (!cpu || vt.handlerAddr === 0) return;

    // Write BREAK trampoline on first use
    if (!vtimerTrampolineWritten) {
      kernel.bus.writeU32(VTIMER_TRAMPOLINE_ADDR, 0x0000000D); // BREAK 0
      kernel.bus.writeU32(VTIMER_TRAMPOLINE_ADDR + 4, 0);       // NOP
      vtimerTrampolineWritten = true;
    }

    const regs = cpu.regs;

    // Save full register state
    const savedGpr = new Uint32Array(32);
    for (let i = 0; i < 32; i++) savedGpr[i] = regs.getGpr(i);
    const savedHi = regs.hi, savedLo = regs.lo, savedPc = regs.pc;
    const savedInDelaySlot = cpu.inDelaySlot;
    const savedDelaySlotTarget = cpu.delaySlotTarget;

    // Reserve stack space and write arguments (PPSSPP VTimerIntrHandler::run)
    const sp = regs.getGpr(29);
    const argArea = sp; // original $sp — write arguments below it
    regs.setGpr(29, sp - HANDLER_STACK_SPACE);

    // Write schedule and currentTime to stack (PPSSPP: argArea-16 and argArea-8)
    writeU64(kernel.bus, argArea - 16, vt.schedule);
    writeU64(kernel.bus, argArea - 8, getVTimerCurrentTime(vt));

    // Set up call: a0=uid, a1=&schedule, a2=&currentTime, a3=commonAddr
    regs.setGpr(4, uid);
    regs.setGpr(5, argArea - 16);
    regs.setGpr(6, argArea - 8);
    regs.setGpr(7, vt.commonAddr);
    regs.setGpr(31, VTIMER_TRAMPOLINE_ADDR); // $ra
    regs.pc = vt.handlerAddr;
    cpu.inDelaySlot = false;

    // Run CPU until callback returns
    let returned = false;
    const prevOnBreak = cpu.onBreak;
    cpu.onBreak = (pc: number) => {
      if (pc === VTIMER_TRAMPOLINE_ADDR) { returned = true; return true; }
      return prevOnBreak ? prevOnBreak(pc) : false;
    };

    const MAX_STEPS = 200_000;
    let steps = 0;
    while (!returned && !cpu.stepFaulted && steps < MAX_STEPS) {
      cpu.step();
      steps++;
    }

    // PPSSPP VTimerIntrHandler::handleResult: if v0==0 cancel, else reschedule with delay=v0
    const result = regs.getGpr(2) >>> 0;

    // Restore registers
    cpu.onBreak = prevOnBreak;
    for (let i = 0; i < 32; i++) regs.setGpr(i, savedGpr[i]!);
    regs.hi = savedHi;
    regs.lo = savedLo;
    regs.pc = savedPc;
    cpu.inDelaySlot = savedInDelaySlot;
    cpu.delaySlotTarget = savedDelaySlotTarget;

    if (result === 0) {
      // Cancel: clear handler
      vt.handlerAddr = 0;
    } else {
      // Reschedule: add result as delay (PPSSPP __rescheduleVTimer)
      scheduleVTimer(uid, vt, vt.schedule + result);
    }
  };

  // Register CoreTiming event for VTimer triggers.
  // IMPORTANT: CoreTiming callbacks fire mid-advance (re-entrant with CPU run loop).
  // We must NOT invoke the guest handler here — instead queue the trigger and process
  // it at a safe boundary (like GE signals are handled between CPU slices).
  const pendingVTimerTriggers: number[] = []; // UIDs to invoke
  let vtimerEventId = -1;
  if (kernel.coreTiming) {
    vtimerEventId = kernel.coreTiming.registerEventType("VTimer", (_cyclesLate, uid) => {
      const vt = vtimers.get(uid);
      if (vt && vt.active && vt.handlerAddr !== 0) {
        pendingVTimerTriggers.push(uid);
      }
    });
  }

  /** Process pending VTimer handler callbacks. Call from a safe boundary (not inside cpu.run). */
  kernel.processVTimerCallbacks = () => {
    while (pendingVTimerTriggers.length > 0) {
      const uid = pendingVTimerTriggers.shift()!;
      const vt = vtimers.get(uid);
      if (vt && vt.active && vt.handlerAddr !== 0) {
        invokeVTimerHandler(uid, vt);
      }
    }
  };

  // sceKernelCreateVTimer(name, optParam)
  kernel.register(VTIMER.sceKernelCreateVTimer, (regs) => {
    const uid = kernel.nextBlockId++;
    vtimers.set(uid, { active: 0, base: 0, current: 0, schedule: 0, handlerAddr: 0, commonAddr: 0 });
    regs.setGpr(2, uid);
  });

  // sceKernelDeleteVTimer(uid)
  kernel.register(VTIMER.sceKernelDeleteVTimer, (regs) => {
    const uid = regs.getGpr(4);
    if (!vtimers.has(uid)) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    vtimers.delete(uid);
    regs.setGpr(2, 0);
  });

  // sceKernelStartVTimer(uid) — PPSSPP: __startVTimer sets active+base, schedules if handler exists
  kernel.register(VTIMER.sceKernelStartVTimer, (regs) => {
    const uid = regs.getGpr(4);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    if (vt.active) { regs.setGpr(2, 1); return; } // already running
    vt.active = 1;
    vt.base = getGlobalTimeUs();
    if (vt.handlerAddr !== 0) scheduleVTimer(uid, vt, vt.schedule);
    regs.setGpr(2, 0);
  });

  // sceKernelStopVTimer(uid) — PPSSPP: accumulate elapsed, clear active
  kernel.register(VTIMER.sceKernelStopVTimer, (regs) => {
    const uid = regs.getGpr(4);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    if (!vt.active) { regs.setGpr(2, 0); return; } // already stopped
    vt.current = getVTimerCurrentTime(vt);
    vt.active = 0;
    vt.base = 0;
    regs.setGpr(2, 1);
  });

  // sceKernelSetVTimerHandler(uid, scheduleAddr, handlerFuncAddr, commonAddr)
  // PPSSPP: always reads u64 schedule from scheduleAddr, stores handler, calls __KernelScheduleVTimer
  kernel.register(VTIMER.sceKernelSetVTimerHandler, (regs) => {
    const uid = regs.getGpr(4);
    const scheduleAddr = regs.getGpr(5);
    const handlerAddr  = regs.getGpr(6);
    const commonAddr   = regs.getGpr(7);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    const schedule = readU64(kernel.bus, scheduleAddr);
    vt.handlerAddr = handlerAddr;
    if (handlerAddr) {
      vt.commonAddr = commonAddr;
      scheduleVTimer(uid, vt, schedule);
    } else {
      // PPSSPP: even when clearing handler, update schedule
      scheduleVTimer(uid, vt, vt.schedule);
    }
    regs.setGpr(2, 0);
  });

  // sceKernelSetVTimerHandlerWide(uid, u64 schedule, handlerFuncAddr, commonAddr)
  // MIPS O32: u64 arg aligned to even register → a2:a3 (regs 6:7), handler=$t0(r8), common=$t1(r9)
  // PPSSPP reads all syscall args from sequential registers: PARAM(n) = r[A0+n]
  kernel.register(VTIMER.sceKernelSetVTimerHandlerWide, (regs) => {
    const uid = regs.getGpr(4);
    const scheduleLo = regs.getGpr(6) >>> 0;
    const scheduleHi = regs.getGpr(7) >>> 0;
    const handlerAddr = regs.getGpr(8); // PARAM(4) = $t0
    const commonAddr  = regs.getGpr(9); // PARAM(5) = $t1
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    const schedule = scheduleHi * 0x100000000 + scheduleLo;
    vt.handlerAddr = handlerAddr;
    if (handlerAddr) {
      vt.commonAddr = commonAddr;
      scheduleVTimer(uid, vt, schedule);
    } else {
      scheduleVTimer(uid, vt, vt.schedule);
    }
    regs.setGpr(2, 0);
  });

  // sceKernelCancelVTimerHandler(uid)
  kernel.register(VTIMER.sceKernelCancelVTimerHandler, (regs) => {
    const uid = regs.getGpr(4);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    vt.handlerAddr = 0;
    regs.setGpr(2, 0);
  });

  // sceKernelGetVTimerBase(uid, baseClockAddr) — writes u64 to pointer, returns 0
  kernel.register(VTIMER.sceKernelGetVTimerBase, (regs) => {
    const uid = regs.getGpr(4);
    const addr = regs.getGpr(5);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    if (addr !== 0) writeU64(kernel.bus, addr, vt.base);
    regs.setGpr(2, 0);
  });

  // sceKernelGetVTimerTime(uid, timeClockAddr) — writes u64 to pointer, returns 0
  kernel.register(VTIMER.sceKernelGetVTimerTime, (regs) => {
    const uid = regs.getGpr(4);
    const addr = regs.getGpr(5);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    if (addr !== 0) writeU64(kernel.bus, addr, getVTimerCurrentTime(vt));
    regs.setGpr(2, 0);
  });

  // sceKernelSetVTimerTime(uid, timeClockAddr) — PPSSPP: read new time, write OLD time back, adjust current
  kernel.register(VTIMER.sceKernelSetVTimerTime, (regs) => {
    const uid = regs.getGpr(4);
    const addr = regs.getGpr(5);
    const vt = vtimers.get(uid);
    if (!vt) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VTID); return; }
    const newTime = readU64(kernel.bus, addr);
    const oldTime = getVTimerCurrentTime(vt);
    // __KernelSetVTimer: current = newTime - runningTime (so getVTimerCurrentTime returns newTime)
    vt.current = newTime - getVTimerRunningTime(vt);
    // Reschedule — time changed, handler may need to fire sooner/later
    scheduleVTimer(uid, vt, vt.schedule);
    if (addr !== 0) writeU64(kernel.bus, addr, oldTime);
    regs.setGpr(2, 0);
  });

  // sceKernelUSec2SysClock(usec, clock*)
  kernel.register(VTIMER.sceKernelUSec2SysClock, (regs) => {
    const usec     = regs.getGpr(4) >>> 0;
    const clockPtr = regs.getGpr(5) >>> 0;
    if (clockPtr !== 0) {
      kernel.bus.writeU32(clockPtr,     usec);
      kernel.bus.writeU32(clockPtr + 4, 0);
    }
    regs.setGpr(2, 0);
  });

  // sceKernelUSec2SysClockWide (same NID as sceKernelGetSystemTime in some sources)
  kernel.register(VTIMER.sceKernelUSec2SysClockWide, (regs) => {
    const us = BigInt(Date.now()) * 1000n;
    regs.setGpr(2, Number(us & 0xFFFFFFFFn));
    regs.setGpr(3, Number((us >> 32n) & 0xFFFFFFFFn));
  });

  // sceRtcCompareTick(tick1Ptr, tick2Ptr) → -1, 0, 1
  kernel.register(RTC.sceRtcCompareTick, (regs, bus) => {
    const ptr1 = regs.getGpr(4);
    const ptr2 = regs.getGpr(5);
    if (ptr1 !== 0 && ptr2 !== 0) {
      const lo1 = bus.readU32(ptr1), hi1 = bus.readU32(ptr1 + 4);
      const lo2 = bus.readU32(ptr2), hi2 = bus.readU32(ptr2 + 4);
      const t1 = BigInt(hi1) * 0x100000000n + BigInt(lo1);
      const t2 = BigInt(hi2) * 0x100000000n + BigInt(lo2);
      if (t1 > t2) { regs.setGpr(2, 1); return; }
      if (t1 < t2) { regs.setGpr(2, (-1 >>> 0)); return; }
    }
    regs.setGpr(2, 0);
  });

  // sceKernelSysClock2USecWide(lowClock, highClock, secPtr, usecPtr)
  kernel.register(VTIMER.sceKernelSysClock2USecWide, (regs, bus) => {
    const lo = regs.getGpr(4) >>> 0;
    const hi = regs.getGpr(5) >>> 0;
    const secPtr  = regs.getGpr(6);
    const usecPtr = regs.getGpr(7);
    const clock = BigInt(hi) * 0x100000000n + BigInt(lo);
    if (secPtr !== 0) {
      bus.writeU32(secPtr, Number(clock / 1_000_000n));
      if (usecPtr !== 0) bus.writeU32(usecPtr, Number(clock % 1_000_000n));
    } else if (usecPtr !== 0) {
      bus.writeU32(usecPtr, Number(clock & 0xFFFFFFFFn));
    }
    regs.setGpr(2, 0);
  });


  // ── Stubs: PSMF (NIDs not covered by hle-psmf-player.ts) ─────────────────
  kernel.stub(PSMF.__PsmfPlayerFinish);
  kernel.stub(PSMF.sceMpegAtracDecode);
  kernel.stub(PSMF.sceMpegAvcConvertToYuv420);
  kernel.stub(PSMF.sceMpegAvcCopyYCbCr);
  kernel.stub(PSMF.sceMpegAvcCsc);
  kernel.stub(PSMF.sceMpegAvcCscInfo);
  kernel.stub(PSMF.sceMpegAvcCscMode);
  kernel.stub(PSMF.sceMpegAvcDecode);
  kernel.stub(PSMF.sceMpegAvcDecodeDetail);
  kernel.stub(PSMF.sceMpegAvcDecodeDetail2);
  kernel.stub(PSMF.sceMpegAvcDecodeDetailIndex);
  kernel.stub(PSMF.sceMpegAvcDecodeFlush);
  kernel.stub(PSMF.sceMpegAvcDecodeStop);
  kernel.stub(PSMF.sceMpegAvcDecodeStopYCbCr);
  kernel.stub(PSMF.sceMpegAvcDecodeYCbCr);
  kernel.stub(PSMF.sceMpegAvcInitYCbCr, 1);
  kernel.stub(PSMF.sceMpegAvcQueryYCbCrSize);
  kernel.stub(PSMF.sceMpegAvcResourceFinish);
  kernel.stub(PSMF.sceMpegAvcResourceGetAvcDecTopAddr, 1);
  kernel.stub(PSMF.sceMpegAvcResourceGetAvcEsBuf);
  kernel.stub(PSMF.sceMpegAvcResourceInit, 1);
  kernel.stub(PSMF.sceMpegBaseCscAvc);
  kernel.stub(PSMF.sceMpegBaseCscAvcRange);
  kernel.stub(PSMF.sceMpegBaseCscInit, 1);
  kernel.stub(PSMF.sceMpegBasePESpacketCopy);
  kernel.stub(PSMF.sceMpegBaseYCrCbCopy);
  kernel.stub(PSMF.sceMpegChangeGetAuMode);
  kernel.stub(PSMF.sceMpegChangeGetAvcAuMode);
  kernel.stub(PSMF.sceMpegFlushAu);
  kernel.stub(PSMF.sceMpegFlushStream);
  kernel.stub(PSMF.sceMpegGetAtracAu);
  kernel.stub(PSMF.sceMpegGetAvcAu);
  kernel.stub(PSMF.sceMpegGetAvcEsAu);
  kernel.stub(PSMF.sceMpegGetAvcNalAu);
  kernel.stub(PSMF.sceMpegGetPcmAu);
  kernel.stub(PSMF.sceMpegGetUserdataAu);
  kernel.stub(PSMF.sceMpegNextAvcRpAu);
  kernel.stub(PSMF.sceMpegQueryAtracEsSize);
  kernel.stub(PSMF.sceMpegQueryPcmEsSize);
  kernel.stub(PSMF.sceMpegQueryUserdataEsSize);
  kernel.stub(PSMF.sceMpegRingbufferAvailableSize);
  kernel.stub(PSMF.sceMpegRingbufferPut);
  kernel.stub(PSMF.sceMpegRingbufferQueryPackNum);
  kernel.stub(PSMF.sceMpeg_11CAB459);
  kernel.stub(PSMF.sceMpeg_988E9E12);
  kernel.stub(PSMF.sceMpeg_B27711A8);
  kernel.stub(PSMF.sceMpeg_C345DED2);
  kernel.stub(PSMF.sceMpeg_D4DD6E75);
  kernel.stub(PSMF.sceMpegbase_0530BE4E);
  kernel.stub(PSMF.scePsmfCheckEPmap);
  kernel.stub(PSMF.scePsmfGetCurrentStreamNumber);
  kernel.stub(PSMF.scePsmfGetEPWithId);
  kernel.stub(PSMF.scePsmfGetEPWithTimestamp);
  kernel.stub(PSMF.scePsmfGetEPidWithTimestamp);
  kernel.stub(PSMF.scePsmfGetNumberOfPsmfMarks);
  kernel.stub(PSMF.scePsmfGetNumberOfSpecificStreams);
  kernel.stub(PSMF.scePsmfGetPsmfMark);
  kernel.stub(PSMF.scePsmfGetPsmfVersion);
  kernel.stub(PSMF.scePsmfQueryStreamOffset);
  kernel.stub(PSMF.scePsmfQueryStreamSize);
  kernel.stub(PSMF.scePsmfSpecifyStream);
  kernel.stub(PSMF.scePsmfSpecifyStreamWithStreamTypeNumber);
  // ── Stubs: RTC ──────────────────────────────────────────────────────────
  kernel.stub(RTC.sceRtcCheckValid);
  kernel.stub(RTC.sceRtcConvertLocalTimeToUTC);
  kernel.stub(RTC.sceRtcConvertUtcToLocalTime);
  kernel.stub(RTC.sceRtcFormatRFC2822);
  kernel.stub(RTC.sceRtcFormatRFC2822LocalTime);
  kernel.stub(RTC.sceRtcFormatRFC3339);
  kernel.stub(RTC.sceRtcFormatRFC3339LocalTime);
  kernel.stub(RTC.sceRtcGetAccumlativeTime);
  kernel.stub(RTC.sceRtcGetAccumulativeTime);
  kernel.stub(RTC.sceRtcGetAlarmTick);
  kernel.stub(RTC.sceRtcGetCurrentNetworkTick);
  kernel.stub(RTC.sceRtcGetDayOfWeek);
  kernel.stub(RTC.sceRtcGetDaysInMonth);
  kernel.stub(RTC.sceRtcGetDosTime);
  kernel.stub(RTC.sceRtcGetLastAdjustedTime);
  kernel.stub(RTC.sceRtcGetLastReincarnatedTime);
  kernel.stub(RTC.sceRtcGetTick);
  kernel.stub(RTC.sceRtcGetTime64_t);
  kernel.stub(RTC.sceRtcGetTime_t);
  kernel.stub(RTC.sceRtcGetWin32FileTime);
  kernel.stub(RTC.sceRtcIsAlarmed);
  kernel.stub(RTC.sceRtcIsLeapYear);
  kernel.stub(RTC.sceRtcParseDateTime);
  kernel.stub(RTC.sceRtcParseRFC3339);
  kernel.stub(RTC.sceRtcRegisterCallback, 1);
  kernel.stub(RTC.sceRtcSetAlarmTick);
  kernel.stub(RTC.sceRtcSetTick);
  kernel.stub(RTC.sceRtcSetTime64_t);
  kernel.stub(RTC.sceRtcSetTime_t);
  kernel.stub(RTC.sceRtcSetWin32FileTime);
  kernel.stub(RTC.sceRtcTickAddDays, 1);
  kernel.stub(RTC.sceRtcTickAddHours, 1);
  kernel.stub(RTC.sceRtcTickAddMinutes, 1);
  kernel.stub(RTC.sceRtcTickAddMonths, 1);
  kernel.stub(RTC.sceRtcTickAddSeconds, 1);
  kernel.stub(RTC.sceRtcTickAddTicks, 1);
  kernel.stub(RTC.sceRtcTickAddWeeks, 1);
  kernel.stub(RTC.sceRtcTickAddYears, 1);
  kernel.stub(RTC.sceRtcUnregisterCallback, 1);

  // ── DEFLT ──────────────────────────────────────────────────────────
  kernel.stub(DEFLT.sceDeflateDecompress);
  kernel.stub(DEFLT.sceGzipDecompress);
  kernel.stub(DEFLT.sceGzipGetComment);
  kernel.stub(DEFLT.sceGzipGetCompressedData);
  kernel.stub(DEFLT.sceGzipGetInfo);
  kernel.stub(DEFLT.sceGzipGetName);
  kernel.stub(DEFLT.sceGzipIsValid);
  kernel.stub(DEFLT.sceZlibAdler32);
  kernel.stub(DEFLT.sceZlibDecompress);
  kernel.stub(DEFLT.sceZlibGetCompressedData);
  kernel.stub(DEFLT.sceZlibGetInfo);
  kernel.stub(DEFLT.sceZlibIsValid);
  // ── G729 ──────────────────────────────────────────────────────────
  kernel.stub(G729.sceG729DecodeCore);
  kernel.stub(G729.sceG729DecodeExit);
  kernel.stub(G729.sceG729DecodeInit, 1);
  kernel.stub(G729.sceG729DecodeInitResource, 1);
  kernel.stub(G729.sceG729DecodeReset);
  kernel.stub(G729.sceG729DecodeTermResource);
  kernel.stub(G729.sceG729EncodeCore);
  kernel.stub(G729.sceG729EncodeExit);
  kernel.stub(G729.sceG729EncodeInit, 1);
  kernel.stub(G729.sceG729EncodeInitResource, 1);
  kernel.stub(G729.sceG729EncodeReset);
  kernel.stub(G729.sceG729EncodeTermResource);
  // ── JPEG ──────────────────────────────────────────────────────────
  kernel.stub(JPEG.sceJpegCreateMJpeg, 1);
  kernel.stub(JPEG.sceJpegCsc);
  kernel.stub(JPEG.sceJpegDecodeMJpeg);
  kernel.stub(JPEG.sceJpegDecodeMJpegSuccessively);
  kernel.stub(JPEG.sceJpegDecodeMJpegYCbCr);
  kernel.stub(JPEG.sceJpegDecodeMJpegYCbCrSuccessively);
  kernel.stub(JPEG.sceJpegDecompressAllImage);
  kernel.stub(JPEG.sceJpegDeleteMJpeg);
  kernel.stub(JPEG.sceJpegFinishMJpeg);
  kernel.stub(JPEG.sceJpegGetOutputInfo);
  kernel.stub(JPEG.sceJpegInitMJpeg, 1);
  kernel.stub(JPEG.sceJpegMJpegCsc);
  kernel.stub(JPEG.sceJpegMJpegCscWithColorOption);
  kernel.stub(JPEG.sceJpeg_9B36444C);
  // ── CCC ──────────────────────────────────────────────────────────
  kernel.stub(CCC.sceCccDecodeSJIS);
  kernel.stub(CCC.sceCccDecodeUTF16);
  kernel.stub(CCC.sceCccDecodeUTF8);
  kernel.stub(CCC.sceCccEncodeSJIS);
  kernel.stub(CCC.sceCccEncodeUTF16);
  kernel.stub(CCC.sceCccEncodeUTF8);
  kernel.stub(CCC.sceCccIsValidJIS);
  kernel.stub(CCC.sceCccIsValidSJIS);
  kernel.stub(CCC.sceCccIsValidUCS2);
  kernel.stub(CCC.sceCccIsValidUCS4);
  kernel.stub(CCC.sceCccIsValidUTF16);
  kernel.stub(CCC.sceCccIsValidUTF8);
  kernel.stub(CCC.sceCccIsValidUnicode);
  kernel.stub(CCC.sceCccJIStoUCS);
  kernel.stub(CCC.sceCccSJIStoUTF16);
  kernel.stub(CCC.sceCccSJIStoUTF8);
  kernel.stub(CCC.sceCccSetErrorCharSJIS);
  kernel.stub(CCC.sceCccSetErrorCharUTF16);
  kernel.stub(CCC.sceCccSetErrorCharUTF8);
  kernel.stub(CCC.sceCccSetTable);
  kernel.stub(CCC.sceCccStrlenSJIS);
  kernel.stub(CCC.sceCccStrlenUTF16);
  kernel.stub(CCC.sceCccUCStoJIS);
  kernel.stub(CCC.sceCccUTF16toSJIS);
  kernel.stub(CCC.sceCccUTF16toUTF8);
  kernel.stub(CCC.sceCccUTF8toSJIS);
  kernel.stub(CCC.sceCccUTF8toUTF16);
  // ── sceReg — PPSSPP sceReg.cpp ────────────────────────────────────
  // PSP system registry — games query language, button assign, network settings, etc.
  // Full registry tree lookup using psp-registry.ts data.

  let regCatHandleGen = 1;
  const regOpenCategories = new Map<number, string>();

  // sceRegOpenRegistry(paramAddr, mode, handleAddr) → 0
  // Only one registry exists; handle is always 0.
  kernel.register(REG.sceRegOpenRegistry, (regs, bus) => {
    const handleAddr = regs.getGpr(6);
    if (handleAddr !== 0) bus.writeU32(handleAddr, 0);
    regs.setGpr(2, 0);
  });

  // sceRegCloseRegistry(handle) → 0
  kernel.register(REG.sceRegCloseRegistry, (regs) => {
    regOpenCategories.clear();
    regs.setGpr(2, 0);
  });

  // sceRegOpenCategory(regHandle, nameAddr, mode, catHandleAddr) → 0 or error
  kernel.register(REG.sceRegOpenCategory, (regs, bus) => {
    const name = kernel.readCString(bus, regs.getGpr(5));
    const catHandleAddr = regs.getGpr(7);
    const result = lookupCategory(name);
    if (!result) {
      if (catHandleAddr !== 0) bus.writeU32(catHandleAddr, (-1 >>> 0));
      log.warn(`sceRegOpenCategory("${name}") → NOT FOUND`);
      regs.setGpr(2, SCE_REG_ERROR_CATEGORY_NOT_FOUND);
      return;
    }
    const catHandle = regCatHandleGen++;
    regOpenCategories.set(catHandle, name);
    if (catHandleAddr !== 0) bus.writeU32(catHandleAddr, catHandle);
    log.debug(`sceRegOpenCategory("${name}") → handle ${catHandle}`);
    regs.setGpr(2, 0);
  });

  // sceRegCloseCategory(catHandle) → 0
  kernel.register(REG.sceRegCloseCategory, (regs) => {
    regOpenCategories.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // sceRegGetKeysNum(catHandle, numAddr) → 0
  kernel.register(REG.sceRegGetKeysNum, (regs, bus) => {
    const catHandle = regs.getGpr(4);
    const numAddr = regs.getGpr(5);
    const path = regOpenCategories.get(catHandle);
    if (path !== undefined) {
      const result = lookupCategory(path);
      if (result && numAddr !== 0) {
        bus.writeU32(numAddr, result.count);
        regs.setGpr(2, 0);
        return;
      }
    }
    if (numAddr !== 0) bus.writeU32(numAddr, 0);
    regs.setGpr(2, 0);
  });

  // sceRegGetKeys(catHandle, bufAddr, num) → 0
  // Writes key names as 27-byte null-terminated strings sequentially.
  kernel.register(REG.sceRegGetKeys, (regs, bus) => {
    const catHandle = regs.getGpr(4);
    const bufAddr = regs.getGpr(5);
    const num = regs.getGpr(6);
    const path = regOpenCategories.get(catHandle);
    if (path !== undefined && bufAddr !== 0) {
      const result = lookupCategory(path);
      if (result) {
        const count = Math.min(num, result.keys.length);
        for (let i = 0; i < count; i++) {
          const nameBytes = result.keys[i]!.name;
          const offset = bufAddr + i * 27;
          // Write name bytes (up to 26 chars + null terminator)
          for (let j = 0; j < 27; j++) {
            bus.writeU8(offset + j, j < nameBytes.length ? nameBytes.charCodeAt(j) : 0);
          }
        }
      }
    }
    regs.setGpr(2, 0);
  });

  // sceRegGetKeyInfo(catHandle, nameAddr, keyHandleAddr, typeAddr, sizeAddr) → 0 or -1
  kernel.register(REG.sceRegGetKeyInfo, (regs, bus) => {
    const catHandle = regs.getGpr(4);
    const name = kernel.readCString(bus, regs.getGpr(5));
    const keyHandleAddr = regs.getGpr(6);
    const typeAddr = regs.getGpr(7);
    // sizeAddr is 5th arg → on stack at sp+16
    const sp = regs.getGpr(29);
    const sizeAddr = bus.readU32(sp + 16);

    const path = regOpenCategories.get(catHandle);
    if (path !== undefined) {
      const result = lookupCategory(path);
      if (result) {
        const nameLower = name.toLowerCase();
        const idx = result.keys.findIndex(k => k.name.toLowerCase() === nameLower);
        if (idx >= 0) {
          const key = result.keys[idx]!;
          // keyHandle = index into keys array
          if (keyHandleAddr !== 0) bus.writeU32(keyHandleAddr, idx);
          // Map type: dir=1, int=2, str=3, bin=4
          let typeCode = REG_TYPE_INT;
          let size = 4;
          if (key.type === "dir") { typeCode = REG_TYPE_DIR; size = 0; }
          else if (key.type === "int") { typeCode = REG_TYPE_INT; size = 4; }
          else if (key.type === "str") { typeCode = REG_TYPE_STR; size = (key.strValue?.length ?? 0) + 1; }
          else if (key.type === "bin") { typeCode = REG_TYPE_BIN; size = key.strValue?.length ?? 0; }
          if (typeAddr !== 0) bus.writeU32(typeAddr, typeCode);
          if (sizeAddr !== 0) bus.writeU32(sizeAddr, size);
          log.debug(`sceRegGetKeyInfo("${name}") → type=${typeCode} size=${size}`);
          regs.setGpr(2, 0);
          return;
        }
      }
    }
    log.warn(`sceRegGetKeyInfo("${name}") → NOT FOUND`);
    regs.setGpr(2, -1);
  });

  // sceRegGetKeyValue(catHandle, keyHandle, bufAddr, size) → 0
  // keyHandle is the index returned by sceRegGetKeyInfo.
  kernel.register(REG.sceRegGetKeyValue, (regs, bus) => {
    const catHandle = regs.getGpr(4);
    const keyHandle = regs.getGpr(5);
    const bufAddr = regs.getGpr(6);
    const size = regs.getGpr(7);

    const path = regOpenCategories.get(catHandle);
    if (path !== undefined && bufAddr !== 0) {
      const result = lookupCategory(path);
      if (result && keyHandle >= 0 && keyHandle < result.keys.length) {
        const key = result.keys[keyHandle]!;
        if (key.type === "int") {
          bus.writeU32(bufAddr, key.intValue ?? 0);
        } else if (key.type === "str" || key.type === "bin") {
          const str = key.strValue ?? "";
          const len = Math.min(str.length, size - 1);
          for (let i = 0; i < len; i++) {
            bus.writeU8(bufAddr + i, str.charCodeAt(i));
          }
          bus.writeU8(bufAddr + len, 0); // null terminator
        }
        regs.setGpr(2, 0);
        return;
      }
    }
    // Fallback: zero fill
    if (bufAddr !== 0 && size >= 4) bus.writeU32(bufAddr, 0);
    regs.setGpr(2, 0);
  });

  // ── Stubs: REG ──────────────────────────────────────────────────────────
  kernel.stub(REG.sceRegRemoveRegistry);
  kernel.stub(REG.sceRegFlushRegistry);
  kernel.stub(REG.sceRegFlushCategory);
  kernel.stub(REG.sceRegCreateKey);
  kernel.stub(REG.sceRegSetKeyValue);
  kernel.stub(REG.sceRegGetKeyInfoByName);
  kernel.stub(REG.sceRegGetKeyValueByName);
  kernel.stub(REG.sceRegRemoveCategory);
  // ── P3DA ──────────────────────────────────────────────────────────
  kernel.stub(P3DA.sceP3daBridgeCore);
  kernel.stub(P3DA.sceP3daBridgeExit);
  kernel.stub(P3DA.sceP3daBridgeInit, 1);

  log.info("Media HLE handlers registered");
}
