/**
 * HLE thread management handlers for sceKernelThread*, module management,
 * callbacks, interrupt stubs, and timing functions.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { ThreadState, WaitType, type ThreadContext, type PSPCallback } from "./hle-kernel.js";
import { THREAD, KERNEL, SYSMEM, ADLER, CHNNLSV, MD5, MT19937, SFMT19937, SHA256 } from "./nids.js";

const log = Logger.get("HLE-THREAD");
const pspLog = Logger.get("PSP");

/** Reset a ThreadContext to PPSSPP's default state (PSPThreadContext::reset). */
function resetThreadContext(ctx: ThreadContext): void {
  ctx.gpr.fill(0xDEADBEEF);
  ctx.gpr[0] = 0;
  // FPR → NaN (0x7f800001)
  const fprU32 = new Uint32Array(ctx.fpr.buffer, ctx.fpr.byteOffset, 32);
  fprU32.fill(0x7f800001);
  // VFPU → NaN
  const vfprU32 = new Uint32Array(ctx.vfpr.buffer, ctx.vfpr.byteOffset, 128);
  vfprU32.fill(0x7f800001);
  // VFPU control regs
  ctx.vfpuCtrl.fill(0);
  ctx.vfpuCtrl[0] = 0xe4; // SPREFIX neutral
  ctx.vfpuCtrl[1] = 0xe4; // TPREFIX neutral
  ctx.vfpuCtrl[3] = 0x3f; // CC
  ctx.vfpuCtrl[5] = 0x7772ceab; // REV
  ctx.vfpuCtrl[6] = 0x3f800001;
  ctx.vfpuCtrl[7] = 0x3f800002;
  ctx.vfpuCtrl[8] = 0x3f800004;
  ctx.vfpuCtrl[9] = 0x3f800008;
  ctx.vfpuCtrl[10] = 0x3f800000;
  ctx.vfpuCtrl[11] = 0x3f800000;
  ctx.vfpuCtrl[12] = 0x3f800000;
  ctx.vfpuCtrl[13] = 0x3f800000;
  ctx.hi = 0xDEADBEEF;
  ctx.lo = 0xDEADBEEF;
  ctx.pc = 0;
  ctx.fcr31 = 0x00000e00;
  ctx.vfpuCc = 0x3f;
  ctx.vpfxs = 0xe4; ctx.vpfxt = 0xe4; ctx.vpfxd = 0;
  ctx.vpfxsEnabled = false; ctx.vpfxtEnabled = false; ctx.vpfxdEnabled = false;
}

export function registerThreadHLE(kernel: HLEKernel): void {

  // ── Exit helpers ─────────────────────────────────────────────────────

  const exitThread = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    if (!kernel.exitCurrentThread(regs)) {
      const anyAlive = [...kernel.threads.values()].some(
        (th) => th.state !== ThreadState.DEAD,
      );
      if (anyAlive) {
        kernel.idleBreak = true;
      } else {
        regs.pc = 0xdeadbeef;
      }
    }
  };

  // sceKernelExitGame
  kernel.register(THREAD.sceKernelExitGame, (regs) => {
    log.info("sceKernelExitGame");
    regs.pc = 0xdeadbeef;
  });

  // sceKernelSelfStopUnloadModule
  kernel.register(THREAD.sceKernelSelfStopUnloadModule, (regs) => {
    log.info("sceKernelSelfStopUnloadModule");
    exitThread(regs);
  });

  // sceKernelExitDeleteThread
  kernel.register(THREAD.sceKernelExitDeleteThread, exitThread);
  // sceKernelExitThread
  kernel.register(THREAD.sceKernelExitThread, exitThread);

  // ── Sleep / Delay ────────────────────────────────────────────────────

  const sleepThread = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.SLEEP;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  };

  const delayThread = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const usec = regs.getGpr(4);
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.DELAY;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (kernel.coreTiming && kernel.wakeThreadEventId >= 0) {
        const cycles = kernel.coreTiming.usToCycles(Math.max(0, usec));
        kernel.coreTiming.scheduleEvent(cycles, kernel.wakeThreadEventId, kernel.currentThreadId);
      }
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  };

  // CB variants set isProcessingCallbacks=true per PPSSPP __KernelReSchedule(true, ...)
  // sceKernelThread.cpp:1641-1642
  const sleepThreadCB = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) t.isProcessingCallbacks = true;
    sleepThread(regs);
  };
  const delayThreadCB = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) t.isProcessingCallbacks = true;
    delayThread(regs);
  };

  kernel.register(THREAD.sceKernelSleepThread,   sleepThread);
  kernel.register(THREAD.sceKernelSleepThreadCB,  sleepThreadCB);
  kernel.register(THREAD.sceKernelDelayThread,    delayThread);
  kernel.register(THREAD.sceKernelDelayThreadCB,  delayThreadCB);

  // ── Create / Start thread ────────────────────────────────────────────

  // sceKernelCreateThread(name, entry, priority, stackSize, attr, option)
  kernel.register(THREAD.sceKernelCreateThread, (regs) => {
    const entry     = regs.getGpr(5);
    const stackSize = regs.getGpr(7);
    const tid = kernel.nextThreadId++;

    const MIN_STACK  = 512;
    const safeSize   = Math.max(stackSize, MIN_STACK);
    const aligned    = (safeSize + 0xFF) & ~0xFF;
    const totalSize  = aligned + 0x100;

    kernel.nextStackTopAddr -= totalSize;
    const stackBase = kernel.nextStackTopAddr;

    if (stackBase < kernel.nextAllocAddr + 0x4000) {
      log.error(`sceKernelCreateThread: stack/heap collision`);
      regs.setGpr(2, -1);
      return;
    }

    const stackTop = (stackBase + aligned) >>> 0;
    const sp = stackTop - 256;
    const k0 = sp;

    // PPSSPP FillStack: fill entire stack with 0xFF, then zero k0 section
    for (let i = 0; i < aligned; i += 4) {
      kernel.bus.writeU32(stackBase + i, 0xFFFFFFFF);
    }
    for (let i = 0; i < 256; i += 4) {
      kernel.bus.writeU32(k0 + i, 0);
    }
    kernel.bus.writeU32(k0 + 0xC0, tid);
    kernel.bus.writeU32(k0 + 0xC8, stackBase);
    kernel.bus.writeU32(k0 + 0xF8, 0xFFFFFFFF);
    kernel.bus.writeU32(k0 + 0xFC, 0xFFFFFFFF);
    kernel.bus.writeU32(stackBase, tid);

    const ctx: ThreadContext = {
      gpr: new Uint32Array(32),
      hi: 0, lo: 0, pc: 0,
      fpr: new Uint32Array(32),
      fcr31: 0,
      vfpr: new Float32Array(128),
      vfpuCtrl: new Uint32Array(16),
      vfpuCc: 0,
      vpfxs: 0, vpfxt: 0, vpfxd: 0,
      vpfxsEnabled: false, vpfxtEnabled: false, vpfxdEnabled: false,
    };
    resetThreadContext(ctx);
    const thread = {
      id: tid, entry, stackSize: aligned, stackBase, stackTop: sp, k0,
      priority: regs.getGpr(6),
      state: ThreadState.DORMANT,
      waitType: WaitType.NONE,
      context: ctx,
      wakeupCount: 0,
      callbacks: [] as number[],
      isProcessingCallbacks: false,
      waitSemaId: 0,
      waitSemaCount: 0,
      waitEvfId: 0,
      waitEvfBits: 0,
      waitEvfMode: 0,
      waitEvfOutPtr: 0,
      waitGeListId: 0,
      waitDeadlineVbl: 0,
      waitWakeTimeMs: 0,
      waitThreadEndId: 0,
      waitMutexId: 0,
      waitMutexCount: 0,
      pendingWakeCallback: undefined as (() => void) | undefined,
    };

    kernel.threads.set(tid, thread);
    log.info(`sceKernelCreateThread(entry=0x${entry.toString(16)}, stack=${stackSize}, sp=0x${sp.toString(16)}) → tid=${tid}`);
    regs.setGpr(2, tid);
  });

  // sceKernelStartThread(thid, arglen, argp)
  kernel.register(THREAD.sceKernelStartThread, (regs) => {
    const thid   = regs.getGpr(4);
    const arglen = regs.getGpr(5);
    const argp   = regs.getGpr(6) >>> 0;
    const thread = kernel.threads.get(thid);
    if (thread) {
      // PPSSPP __KernelResetThread: reset context before starting
      resetThreadContext(thread.context);
      let sp = thread.stackTop;
      thread.context.pc        = thread.entry;
      thread.context.gpr[26]   = thread.k0;
      thread.context.gpr[28]   = regs.getGpr(28);

      // Copy args to new thread's stack (matches PPSSPP)
      if (arglen > 0 && argp !== 0) {
        sp -= (arglen + 0xf) & ~0xf; // 16-byte aligned
        thread.context.gpr[4] = arglen;
        thread.context.gpr[5] = sp;
        // Copy arglen bytes from argp to new stack
        for (let i = 0; i < arglen; i++) {
          kernel.bus.writeU8(sp + i, kernel.bus.readU8(argp + i));
        }
      } else {
        thread.context.gpr[4] = 0;
        thread.context.gpr[5] = 0;
      }

      // Extra 64 bytes eaten after args (matches PPSSPP)
      sp -= 64;
      thread.context.gpr[29]   = sp;
      thread.context.gpr[30]   = sp; // fp = sp
      thread.context.gpr[31]   = kernel.threadReturnAddr;
      thread.state = ThreadState.READY;

      log.info(`sceKernelStartThread(tid=${thid}, arglen=${arglen}, argp=0x${argp.toString(16)}, sp=0x${sp.toString(16)})`);

      if (kernel.currentThreadId === 0) {
        kernel.pendingThreadEntry = { entry: thread.entry, arglen, argp, sp, k0: thread.k0 };
      } else {
        // Reschedule if new thread has better (lower number) priority
        const current = kernel.threads.get(kernel.currentThreadId);
        if (current && current.priority > thread.priority) {
          kernel.reschedule(regs);
        }
      }
    }
    regs.setGpr(2, 0);
  });

  // sceKernelChangeThreadPriority (0xea748e31) and sceKernelChangeCurrentThreadAttr (0x71bc9871)
  const changeThreadPriority = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const thid   = regs.getGpr(4);
    const newPri = regs.getGpr(5);
    const tid    = thid === 0 ? kernel.currentThreadId : thid;
    const t      = kernel.threads.get(tid);
    if (t) { t.priority = newPri; }
    regs.setGpr(2, 0);
  };
  kernel.register(THREAD.sceKernelChangeCurrentThreadAttr, changeThreadPriority);
  kernel.register(THREAD.sceKernelChangeThreadPriority,    changeThreadPriority);

  // sceKernelWakeupThread(thid)
  kernel.register(THREAD.sceKernelWakeupThread, (regs) => {
    const thid = regs.getGpr(4);
    const t    = kernel.threads.get(thid);
    if (t && t.state === ThreadState.WAITING && t.waitType === WaitType.SLEEP) {
      t.state    = ThreadState.READY;
      t.waitType = WaitType.NONE;
      t.context.gpr[2] = 0;
    }
    regs.setGpr(2, 0);
  });

  // sceKernelGetThreadExitStatus(thid)
  kernel.register(THREAD.sceKernelGetThreadExitStatus, (regs) => {
    const thid = regs.getGpr(4);
    const t    = kernel.threads.get(thid);
    if (t && t.state === ThreadState.DEAD) {
      regs.setGpr(2, 0);
    } else if (t) {
      regs.setGpr(2, 0x800201a4 >>> 0);
    } else {
      regs.setGpr(2, 0x800201bc >>> 0);
    }
  });

  // sceKernelWaitThreadEnd(thid, timeout)
  kernel.register(THREAD.sceKernelWaitThreadEnd, (regs) => {
    const thid = regs.getGpr(4);
    const t    = kernel.threads.get(thid);
    if (!t || t.state === ThreadState.DEAD || t.state === ThreadState.DORMANT) {
      regs.setGpr(2, 0);
      return;
    }
    // Block current thread until target dies
    const cur = kernel.threads.get(kernel.currentThreadId);
    if (cur) {
      cur.state = ThreadState.WAITING;
      cur.waitType = WaitType.THREAD_END;
      cur.waitThreadEndId = thid;
      kernel.saveContext(cur, regs);
      cur.context.gpr[2] = 0; // v0 = 0 when we wake
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    }
  });

  // sceKernelDeleteThread(thid)
  kernel.register(THREAD.sceKernelDeleteThread, (regs) => {
    kernel.threads.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // sceKernelGetThreadId()
  kernel.register(THREAD.sceKernelGetThreadId, (regs) => {
    regs.setGpr(2, kernel.currentThreadId || 1);
  });

  // sceKernelGetThreadCurrentPriority()
  kernel.register(THREAD.sceKernelGetThreadCurrentPriority, (regs) => {
    const t = kernel.threads.get(kernel.currentThreadId);
    regs.setGpr(2, t ? t.priority : 32);
  });

  // sceKernelCheckThreadStack()
  kernel.register(THREAD.sceKernelCheckThreadStack, (regs) => {
    regs.setGpr(2, 0x4000);
  });

  // ── Module management ────────────────────────────────────────────────

  // sceKernelLoadModule
  kernel.register(KERNEL.sceKernelLoadModule, (regs) => {
    log.debug("sceKernelLoadModule (stub)");
    regs.setGpr(2, 0x80);
  });

  // sceKernelLoadModuleByID
  kernel.register(KERNEL.sceKernelLoadModuleByID, (regs) => {
    log.debug("sceKernelLoadModuleByID (stub)");
    regs.setGpr(2, 0x80);
  });

  // sceKernelStartModule
  kernel.register(KERNEL.sceKernelStartModule, (regs) => {
    log.debug("sceKernelStartModule (stub)");
    regs.setGpr(2, 0);
  });

  // sceKernelSelfStopUnloadModuleWithStatus
  kernel.register(KERNEL.sceKernelSelfStopUnloadModuleWithStatus, (regs) => {
    log.debug("sceKernelSelfStopUnloadModuleWithStatus (stub)");
    regs.setGpr(2, 0);
  });

  // ── Callbacks ────────────────────────────────────────────────────────

  // sceKernelCreateCallback(name, entrypoint, commonArg) → cbId
  // PPSSPP sceKernelThread.cpp:2668-2692
  kernel.register(KERNEL.sceKernelCreateCallback, (regs, bus) => {
    const nameAddr = regs.getGpr(4);
    const entrypoint = regs.getGpr(5);
    const commonArg = regs.getGpr(6);

    let name = "";
    for (let i = 0; i < 32; i++) {
      const b = bus.readU8(nameAddr + i);
      if (b === 0) break;
      name += String.fromCharCode(b);
    }

    const cbId = kernel.nextPspCallbackId++;
    const cb: PSPCallback = {
      id: cbId,
      name,
      threadId: kernel.currentThreadId,
      entrypoint,
      commonArg,
      notifyCount: 0,
      notifyArg: 0,
    };
    kernel.pspCallbacks.set(cbId, cb);

    // Register with owning thread — PPSSPP sceKernelThread.cpp:2688-2689
    const thread = kernel.threads.get(kernel.currentThreadId);
    if (thread) thread.callbacks.push(cbId);

    log.info(`sceKernelCreateCallback("${name}", entry=0x${entrypoint.toString(16)}, arg=0x${commonArg.toString(16)}) → cbId=${cbId}`);
    regs.setGpr(2, cbId);
  });

  // sceKernelDeleteCallback(cbId) — PPSSPP sceKernelThread.cpp:2694-2712
  kernel.register(KERNEL.sceKernelDeleteCallback, (regs) => {
    const cbId = regs.getGpr(4);
    const cb = kernel.pspCallbacks.get(cbId);
    if (cb) {
      const thread = kernel.threads.get(cb.threadId);
      if (thread) {
        const idx = thread.callbacks.indexOf(cbId);
        if (idx >= 0) thread.callbacks.splice(idx, 1);
      }
      kernel.pspCallbacks.delete(cbId);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x80020198); // SCE_KERNEL_ERROR_UNKNOWN_CBID
    }
  });

  // sceKernelNotifyCallback(cbId, notifyArg) — PPSSPP sceKernelThread.cpp:2713-2723
  kernel.register(KERNEL.sceKernelNotifyCallback, (regs) => {
    const cbId = regs.getGpr(4);
    const notifyArg = regs.getGpr(5);
    const cb = kernel.pspCallbacks.get(cbId);
    if (cb) {
      cb.notifyCount++;
      cb.notifyArg = notifyArg;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x80020198);
    }
  });

  // sceKernelCancelCallback(cbId) — PPSSPP sceKernelThread.cpp:2725-2736
  kernel.register(KERNEL.sceKernelCancelCallback, (regs) => {
    const cbId = regs.getGpr(4);
    const cb = kernel.pspCallbacks.get(cbId);
    if (cb) {
      cb.notifyCount = 0;
      cb.notifyArg = 0;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x80020198);
    }
  });

  // sceKernelGetCallbackCount(cbId) — PPSSPP sceKernelThread.cpp:2738-2747
  kernel.register(KERNEL.sceKernelGetCallbackCount, (regs) => {
    const cbId = regs.getGpr(4);
    const cb = kernel.pspCallbacks.get(cbId);
    regs.setGpr(2, cb ? cb.notifyCount : 0x80020198);
  });

  // sceKernelCheckCallback() — PPSSPP sceKernelThread.cpp:3377-3390
  // Forces callback processing on current thread.
  kernel.register(KERNEL.sceKernelCheckCallback, (regs) => {
    const processed = kernel.processThreadCallbacks(regs);
    regs.setGpr(2, processed ? 1 : 0);
  });

  // _sceKernelReturnFromCallback — PPSSPP: just returns, callback cleanup handled by framework
  kernel.register(KERNEL._sceKernelReturnFromCallback, (regs) => {
    regs.setGpr(2, 0);
  });

  // ── Timing ──────────────────────────────────────────────────────────

  // sceKernelPrintf
  kernel.register(KERNEL.sceKernelPrintf, (regs, bus) => {
    const fmtPtr = regs.getGpr(4);
    let fmt = "";
    let i = 0;
    while (true) {
      const b = bus.readU8(fmtPtr + i++);
      if (b === 0) break;
      fmt += String.fromCharCode(b);
    }
    pspLog.info(`${fmt.replace(/\n$/, "")}`);
    regs.setGpr(2, 0);
  });

  // Helper: get emulated microseconds from CoreTiming
  function getEmulatedUs(): bigint {
    const ct = kernel.coreTiming!;
    return BigInt(ct.cyclesToUs(ct.getTicks()));
  }

  // sceKernelGetSystemTimeWide
  kernel.register(KERNEL.sceKernelGetSystemTimeWide, (regs) => {
    const us = getEmulatedUs();
    regs.setGpr(2, Number(us & 0xFFFFFFFFn));
    regs.setGpr(3, Number((us >> 32n) & 0xFFFFFFFFn));
  });

  // sceKernelGetSystemTimeLow
  kernel.register(KERNEL.sceKernelGetSystemTimeLow, (regs) => {
    regs.setGpr(2, Number(getEmulatedUs() & 0xFFFFFFFFn));
  });

  // sceKernelGetSystemTime(clock_ptr) — NID 0xdb738f35
  kernel.register(KERNEL.sceKernelGetSystemTime, (regs, bus) => {
    const ptr = regs.getGpr(4);
    const us = getEmulatedUs();
    if (ptr !== 0) {
      bus.writeU32(ptr,     Number(us & 0xFFFFFFFFn));
      bus.writeU32(ptr + 4, Number((us >> 32n) & 0xFFFFFFFFn));
    }
    regs.setGpr(2, 0);
  });

  // sceKernelSysClock2USec (NID 0xba6b92e2 — also in VTIMER, registered there)
  kernel.register(KERNEL.sceKernelSysClock2USec, (regs, bus) => {
    const clockPtr = regs.getGpr(4);
    const secPtr   = regs.getGpr(5);
    const uSecPtr  = regs.getGpr(6);
    const lo = clockPtr !== 0 ? bus.readU32(clockPtr)     : 0;
    const hi = clockPtr !== 0 ? bus.readU32(clockPtr + 4) : 0;
    const usec = BigInt(hi) * 0x100000000n + BigInt(lo);
    if (secPtr  !== 0) bus.writeU32(secPtr,  Number(usec / 1_000_000n));
    if (uSecPtr !== 0) bus.writeU32(uSecPtr, Number(usec % 1_000_000n));
    regs.setGpr(2, 0);
  });

  // sceKernelLibcClock() — returns microseconds since boot
  kernel.register(KERNEL.sceKernelLibcClock, (regs) => {
    regs.setGpr(2, Number(getEmulatedUs() & 0xFFFFFFFFn));
  });

  // sceKernelLibcGettimeofday(timeAddr, tzAddr)
  const startTimeUnix = Math.floor(Date.now() / 1000);
  kernel.register(KERNEL.sceKernelLibcGettimeofday, (regs, bus) => {
    const timeAddr = regs.getGpr(4) >>> 0;
    if (timeAddr >= 0x08000000 && timeAddr < 0x0C000000) {
      const us = getEmulatedUs();
      const sec = startTimeUnix + Number(us / 1_000_000n);
      const usec = Number(us % 1_000_000n);
      bus.writeU32(timeAddr, sec >>> 0);
      bus.writeU32(timeAddr + 4, usec >>> 0);
    }
    regs.setGpr(2, 0);
  });

  // sceKernelLibcTime(outPtr) — returns unix timestamp
  kernel.register(KERNEL.sceKernelLibcTime, (regs, bus) => {
    const outPtr = regs.getGpr(4) >>> 0;
    const us = getEmulatedUs();
    const t = (startTimeUnix + Number(us / 1_000_000n)) >>> 0;
    if (outPtr !== 0) {
      if (outPtr >= 0x08000000 && outPtr < 0x0C000000) {
        bus.writeU32(outPtr, t);
      } else {
        regs.setGpr(2, 0);
        return;
      }
    }
    regs.setGpr(2, t);
  });

  // ── Sub-interrupt handlers (PPSSPP sceKernelInterrupt.cpp) ────────────────
  // PSP has 67 interrupt lines, each with up to 32 sub-interrupts.
  const PSP_NUMBER_INTERRUPTS = 67;
  const PSP_NUMBER_SUBINTERRUPTS = 32;
  const SCE_KERNEL_ERROR_ILLEGAL_INTRCODE = 0x80020065;
  const SCE_KERNEL_ERROR_FOUND_HANDLER    = 0x80020068;
  const SCE_KERNEL_ERROR_NOTFOUND_HANDLER = 0x80020069;

  interface SubIntrEntry { handler: number; arg: number; enabled: boolean; }
  const subIntrs = new Map<number, SubIntrEntry>(); // key = intrNumber * 32 + subIntrNumber

  // sceKernelRegisterSubIntrHandler(intrNumber, subIntrNumber, handler, handlerArg)
  kernel.register(KERNEL.sceKernelRegisterSubIntrHandler, (regs) => {
    const intrNum = regs.getGpr(4);
    const subNum  = regs.getGpr(5);
    const handler = regs.getGpr(6);
    const arg     = regs.getGpr(7);
    if (intrNum >= PSP_NUMBER_INTERRUPTS || subNum >= PSP_NUMBER_SUBINTERRUPTS) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_INTRCODE); return;
    }
    const key = intrNum * 32 + subNum;
    if (subIntrs.has(key)) {
      regs.setGpr(2, SCE_KERNEL_ERROR_FOUND_HANDLER); return;
    }
    subIntrs.set(key, { handler, arg, enabled: false });
    regs.setGpr(2, 0);
  });

  // sceKernelReleaseSubIntrHandler(intrNumber, subIntrNumber)
  kernel.register(KERNEL.sceKernelReleaseSubIntrHandler, (regs) => {
    const intrNum = regs.getGpr(4);
    const subNum  = regs.getGpr(5);
    if (intrNum >= PSP_NUMBER_INTERRUPTS || subNum >= PSP_NUMBER_SUBINTERRUPTS) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_INTRCODE); return;
    }
    const key = intrNum * 32 + subNum;
    const entry = subIntrs.get(key);
    if (!entry || entry.handler === 0) {
      regs.setGpr(2, SCE_KERNEL_ERROR_NOTFOUND_HANDLER); return;
    }
    subIntrs.delete(key);
    regs.setGpr(2, 0);
  });

  // sceKernelEnableSubIntr(intrNumber, subIntrNumber)
  kernel.register(KERNEL.sceKernelEnableSubIntr, (regs) => {
    const intrNum = regs.getGpr(4);
    const subNum  = regs.getGpr(5);
    if (intrNum >= PSP_NUMBER_INTERRUPTS || subNum >= PSP_NUMBER_SUBINTERRUPTS) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_INTRCODE); return;
    }
    const key = intrNum * 32 + subNum;
    if (!subIntrs.has(key)) {
      // Enabling before registering is valid — create a placeholder
      subIntrs.set(key, { handler: 0, arg: 0, enabled: true });
    } else {
      subIntrs.get(key)!.enabled = true;
    }
    regs.setGpr(2, 0);
  });

  // sceKernelDisableSubIntr(intrNumber, subIntrNumber)
  kernel.register(KERNEL.sceKernelDisableSubIntr, (regs) => {
    const intrNum = regs.getGpr(4);
    const subNum  = regs.getGpr(5);
    if (intrNum >= PSP_NUMBER_INTERRUPTS || subNum >= PSP_NUMBER_SUBINTERRUPTS) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_INTRCODE); return;
    }
    const key = intrNum * 32 + subNum;
    const entry = subIntrs.get(key);
    if (entry) entry.enabled = false;
    regs.setGpr(2, 0);
  });

  // sceKernelCpuSuspendIntr() → returns previous interrupt state
  kernel.register(KERNEL.sceKernelCpuSuspendIntr, (regs) => {
    regs.setGpr(2, 1); // pretend interrupts were enabled
  });

  // sceKernelCpuResumeIntr(flags) / sceKernelCpuResumeIntrWithSync(flags)
  kernel.register(KERNEL.sceKernelCpuResumeIntr, (regs) => { regs.setGpr(2, 0); });
  kernel.register(KERNEL.sceKernelCpuResumeIntrWithSync, (regs) => { regs.setGpr(2, 0); });

  // sceKernelReferThreadStatus — PPSSPP sceKernelThread.cpp: fill SceKernelThreadInfo struct
  kernel.register(THREAD.sceKernelReferThreadStatus, (regs, bus) => {
    let thid = regs.getGpr(4);
    const statusPtr = regs.getGpr(5);
    if (thid === 0) thid = kernel.currentThreadId;
    const t = kernel.threads.get(thid);
    if (!t) { regs.setGpr(2, 0x800201bc); return; } // SCE_KERNEL_ERROR_UNKNOWN_THID
    if (statusPtr !== 0) {
      // Fill key fields of SceKernelThreadInfo
      bus.writeU32(statusPtr + 40, t.state);
      bus.writeU32(statusPtr + 44, t.entry);
      bus.writeU32(statusPtr + 48, t.stackBase);
      bus.writeU32(statusPtr + 52, t.stackSize);
      bus.writeU32(statusPtr + 64, t.priority);
      bus.writeU32(statusPtr + 68, t.waitType);
      bus.writeU32(statusPtr + 76, t.wakeupCount);
    }
    regs.setGpr(2, 0);
  });

  kernel.register(KERNEL.sceKernelGetGPI, (regs) => { regs.setGpr(2, 0); });
  kernel.register(KERNEL.sceKernelSetGPO, (regs) => { regs.setGpr(2, 0); });
  kernel.register(KERNEL.sceKernelRegisterExitCallback, (regs) => { regs.setGpr(2, 0); });
  kernel.register(KERNEL.sceKernelImposeSetLanguageMode, (regs) => { regs.setGpr(2, 0); });

  // sceKernelGetModuleId() — PPSSPP sceKernelModule.cpp:2402
  // We only have one module so return fixed ID 1
  kernel.register(KERNEL.sceKernelGetModuleId, (regs) => {
    regs.setGpr(2, 1);
  });

  // sceKernelGetModuleIdByAddress(addr) — PPSSPP sceKernelModule.cpp:2382-2400
  // Any RAM address → module 1; otherwise SCE_KERNEL_ERROR_UNKNOWN_MODULE
  kernel.register(KERNEL.sceKernelGetModuleIdByAddress, (regs) => {
    const addr = regs.getGpr(4);
    const phys = addr & 0x1FFFFFFF;
    if (phys >= 0x08000000 && phys < 0x0C000000) {
      regs.setGpr(2, 1);
    } else {
      regs.setGpr(2, 0x800200cb); // SCE_KERNEL_ERROR_UNKNOWN_MODULE
    }
  });

  // ── Mailbox (Mbx) — PPSSPP sceKernelMbx.cpp ────────────────────────────
  const SCE_KERNEL_ERROR_UNKNOWN_MBXID = 0x8002019b >>> 0;
  const SCE_KERNEL_ERROR_MBOX_NOMSG    = 0x800201b2 >>> 0;
  const mbxes = new Map<number, { messages: number[] }>();

  kernel.register(KERNEL.sceKernelCreateMbx, (regs) => {
    const mid = kernel.nextBlockId++;
    mbxes.set(mid, { messages: [] });
    regs.setGpr(2, mid);
  });

  kernel.register(KERNEL.sceKernelDeleteMbx, (regs) => {
    const id = regs.getGpr(4);
    if (!mbxes.has(id)) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_MBXID); return; }
    mbxes.delete(id);
    regs.setGpr(2, 0);
  });

  kernel.register(KERNEL.sceKernelSendMbx, (regs) => {
    const id = regs.getGpr(4);
    const msgPtr = regs.getGpr(5);
    const mbx = mbxes.get(id);
    if (!mbx) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_MBXID); return; }
    mbx.messages.push(msgPtr);
    regs.setGpr(2, 0);
  });

  kernel.register(KERNEL.sceKernelPollMbx, (regs, bus) => {
    const id = regs.getGpr(4);
    const msgPtrPtr = regs.getGpr(5);
    const mbx = mbxes.get(id);
    if (!mbx) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_MBXID); return; }
    if (mbx.messages.length === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_MBOX_NOMSG); return; }
    const msg = mbx.messages.shift()!;
    if (msgPtrPtr !== 0) bus.writeU32(msgPtrPtr, msg);
    regs.setGpr(2, 0);
  });

  kernel.register(KERNEL.sceKernelReceiveMbx, (regs, bus) => {
    const id = regs.getGpr(4);
    const msgPtrPtr = regs.getGpr(5);
    const mbx = mbxes.get(id);
    if (!mbx) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_MBXID); return; }
    if (mbx.messages.length > 0) {
      const msg = mbx.messages.shift()!;
      if (msgPtrPtr !== 0) bus.writeU32(msgPtrPtr, msg);
      regs.setGpr(2, 0);
    } else {
      // TODO: block thread until message arrives
      regs.setGpr(2, 0);
    }
  });

  kernel.register(KERNEL.sceKernelReceiveMbxCB, (regs, bus) => {
    const id = regs.getGpr(4);
    const msgPtrPtr = regs.getGpr(5);
    const mbx = mbxes.get(id);
    if (!mbx) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_MBXID); return; }
    if (mbx.messages.length > 0) {
      const msg = mbx.messages.shift()!;
      if (msgPtrPtr !== 0) bus.writeU32(msgPtrPtr, msg);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0);
    }
  });

  // sceKernelTerminateThread(thid) — force a thread to DORMANT
  kernel.register(KERNEL.sceKernelTerminateThread, (regs) => {
    const thid = regs.getGpr(4);
    const t = kernel.threads.get(thid);
    if (!t) { regs.setGpr(2, 0x800201bc >>> 0); return; } // UNKNOWN_THID
    t.state = ThreadState.DORMANT;
    t.waitType = WaitType.NONE;
    regs.setGpr(2, 0);
  });

  // sceKernelTerminateDeleteThread(thid)
  kernel.register(KERNEL.sceKernelTerminateDeleteThread, (regs) => {
    const thid = regs.getGpr(4);
    const t = kernel.threads.get(thid);
    if (!t) { regs.setGpr(2, 0x800201bc >>> 0); return; }
    t.state = ThreadState.DEAD;
    kernel.threads.delete(thid);
    regs.setGpr(2, 0);
  });

  // ── Stubs: THREAD ──────────────────────────────────────────────────────────
  kernel.stub(THREAD.sceKernelRotateThreadReadyQueue);
  kernel.stub(THREAD.sceKernelSuspendThread);
  kernel.stub(THREAD.sceKernelResumeThread);
  // sceKernelWaitThreadEndCB — same as WaitThreadEnd but allows callbacks
  kernel.register(THREAD.sceKernelWaitThreadEndCB, (regs) => {
    const thid = regs.getGpr(4);
    const t    = kernel.threads.get(thid);
    if (!t || t.state === ThreadState.DEAD || t.state === ThreadState.DORMANT) {
      regs.setGpr(2, 0);
      return;
    }
    const cur = kernel.threads.get(kernel.currentThreadId);
    if (cur) {
      cur.state = ThreadState.WAITING;
      cur.waitType = WaitType.THREAD_END;
      cur.waitThreadEndId = thid;
      cur.isProcessingCallbacks = true;
      kernel.saveContext(cur, regs);
      cur.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    }
  });

  // ── Stubs: KERNEL ──────────────────────────────────────────────────────────
  kernel.stub(KERNEL.LoadExecForUser_362A956B, 1);
  kernel.stub(KERNEL.LoadExecForUser_8ADA38D3, 1);
  kernel.stub(KERNEL.ModuleMgrForUser_E4C4211C);
  kernel.stub(KERNEL.ModuleMgrForUser_FBE27467);
  kernel.stub(KERNEL.QueryIntrHandlerInfo);
  kernel.stub(KERNEL.ThreadManForUser_28BFD974);
  kernel.stub(KERNEL.UtilsForKernel_6C6887EE);
  kernel.stub(KERNEL._sceKernelAllocateTlspl, 1);
  kernel.stub(KERNEL._sceKernelExitThread);
  kernel.stub(KERNEL._sceKernelLockLwMutex);
  kernel.stub(KERNEL._sceKernelLockLwMutexCB);
  kernel.stub(KERNEL._sceKernelReturnFromTimerHandler);
  kernel.stub(KERNEL._sceKernelTryLockLwMutex);
  kernel.stub(KERNEL._sceKernelUnlockLwMutex);
  kernel.stub(KERNEL.memcmp);
  kernel.stub(KERNEL.memcpy);
  kernel.stub(KERNEL.memmove);
  kernel.stub(KERNEL.memset);
  kernel.stub(KERNEL.sceKernelAllocateFplCB, 1);
  kernel.stub(KERNEL.sceKernelAllocateVplCB, 1);
  kernel.stub(KERNEL.sceKernelCancelAlarm);
  kernel.stub(KERNEL.sceKernelCancelEventFlag);
  kernel.stub(KERNEL.sceKernelCancelFpl);
  kernel.stub(KERNEL.sceKernelCancelMsgPipe);
  kernel.stub(KERNEL.sceKernelCancelMutex);
  kernel.stub(KERNEL.sceKernelCancelReceiveMbx);
  kernel.stub(KERNEL.sceKernelCancelSema);
  kernel.stub(KERNEL.sceKernelCancelVpl);
  kernel.stub(KERNEL.sceKernelCancelWakeupThread);
  kernel.stub(KERNEL.sceKernelCreateTlspl, 1);
  kernel.stub(KERNEL.sceKernelDcacheInvalidateRange);
  kernel.stub(KERNEL.sceKernelDeflateDecompress);
  kernel.stub(KERNEL.sceKernelDelaySysClockThread);
  kernel.stub(KERNEL.sceKernelDelaySysClockThreadCB);
  kernel.stub(KERNEL.sceKernelDeleteTlspl);
  kernel.stub(KERNEL.sceKernelDonateWakeupThread);
  kernel.stub(KERNEL.sceKernelExitGameWithStatus);
  kernel.stub(KERNEL.sceKernelExitVSHKernel);
  kernel.stub(KERNEL.sceKernelExitVSHVSH);
  kernel.stub(KERNEL.sceKernelExtendThreadStack);
  kernel.stub(KERNEL.sceKernelFreeTlspl);
  kernel.stub(KERNEL.sceKernelGetActiveDefaultExceptionHandler);
  kernel.stub(KERNEL.sceKernelGetModuleIdList);
  kernel.stub(KERNEL.sceKernelGetThreadStackFreeSize);
  kernel.stub(KERNEL.sceKernelGetThreadmanIdList);
  kernel.stub(KERNEL.sceKernelGetThreadmanIdType);
  kernel.stub(KERNEL.sceKernelGetTlsAddr, 1);
  kernel.stub(KERNEL.sceKernelGetVTimerBaseWide);
  kernel.stub(KERNEL.sceKernelGetVTimerTimeWide);
  kernel.stub(KERNEL.sceKernelGzipDecompress);
  kernel.stub(KERNEL.sceKernelIsCpuIntrEnable, 1);
  kernel.stub(KERNEL.sceKernelIsCpuIntrSuspended);
  kernel.stub(KERNEL.sceKernelIsSubInterruptOccurred);
  kernel.stub(KERNEL.sceKernelLoadExec, 1);
  kernel.stub(KERNEL.sceKernelLoadExecVSHMs2, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleBufferUsbWlan, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleDNAS, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleForLoadExecVSHDisc, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleMs, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleNpDrm, 1);
  kernel.stub(KERNEL.sceKernelLockLwMutex);
  kernel.stub(KERNEL.sceKernelLockLwMutexCB);
  kernel.stub(KERNEL.sceKernelLockMutexCB);
  kernel.stub(KERNEL.sceKernelMemcpy);
  kernel.stub(KERNEL.sceKernelQueryModuleInfo);
  kernel.stub(KERNEL.sceKernelReferAlarmStatus);
  kernel.stub(KERNEL.sceKernelReferCallbackStatus);
  kernel.stub(KERNEL.sceKernelReferEventFlagStatus);
  kernel.stub(KERNEL.sceKernelReferFplStatus);
  kernel.stub(KERNEL.sceKernelReferGlobalProfiler);
  kernel.stub(KERNEL.sceKernelReferLwMutexStatus);
  kernel.stub(KERNEL.sceKernelReferMbxStatus);
  kernel.stub(KERNEL.sceKernelReferMsgPipeStatus);
  kernel.stub(KERNEL.sceKernelReferMutexStatus);
  kernel.stub(KERNEL.sceKernelReferSystemStatus);
  kernel.stub(KERNEL.sceKernelReferThreadEventHandlerStatus);
  kernel.stub(KERNEL.sceKernelReferThreadProfiler);
  kernel.stub(KERNEL.sceKernelReferThreadRunStatus);
  kernel.stub(KERNEL.sceKernelReferTlsplStatus);
  kernel.stub(KERNEL.sceKernelReferVTimerStatus);
  kernel.stub(KERNEL.sceKernelReferVplStatus);
  kernel.stub(KERNEL.sceKernelRegisterDefaultExceptionHandler, 1);
  kernel.stub(KERNEL.sceKernelRegisterExceptionHandler, 1);
  kernel.stub(KERNEL.sceKernelRegisterNmiHandler, 1);
  kernel.stub(KERNEL.sceKernelRegisterPriorityExceptionHandler, 1);
  kernel.stub(KERNEL.sceKernelRegisterThreadEventHandler, 1);
  kernel.stub(KERNEL.sceKernelRegisterUserSpaceIntrStack, 1);
  kernel.stub(KERNEL.sceKernelReleaseDefaultExceptionHandler);
  kernel.stub(KERNEL.sceKernelReleaseExceptionHandler);
  kernel.stub(KERNEL.sceKernelReleaseNmiHandler);
  kernel.stub(KERNEL.sceKernelReleaseThreadEventHandler);
  kernel.stub(KERNEL.sceKernelReleaseWaitThread);
  kernel.stub(KERNEL.sceKernelResumeDispatchThread);
  kernel.stub(KERNEL.sceKernelResumeSubIntr);
  kernel.stub(KERNEL.sceKernelSendMsgPipeCB);
  kernel.stub(KERNEL.sceKernelSetAlarm);
  kernel.stub(KERNEL.sceKernelSetSysClockAlarm);
  kernel.stub(KERNEL.sceKernelSetVTimerTimeWide);
  kernel.stub(KERNEL.sceKernelStopModule);
  kernel.stub(KERNEL.sceKernelStopUnloadSelfModule, 1);
  kernel.stub(KERNEL.sceKernelSuspendDispatchThread);
  kernel.stub(KERNEL.sceKernelSuspendSubIntr);
  kernel.stub(KERNEL.sceKernelTryLockLwMutex);
  kernel.stub(KERNEL.sceKernelTryLockLwMutex_600);
  kernel.stub(KERNEL.sceKernelUnlockLwMutex);
  kernel.stub(KERNEL.sceKernelUnloadModule);
  kernel.stub(KERNEL.sceKernelUnregisterSubIntrHandler);
  kernel.stub(KERNEL.sceKernelUtilsMd5BlockInit, 1);
  kernel.stub(KERNEL.sceKernelUtilsMd5BlockResult);
  kernel.stub(KERNEL.sceKernelUtilsMd5BlockUpdate);
  kernel.stub(KERNEL.sceKernelUtilsMd5Digest);
  kernel.stub(KERNEL.sceKernelUtilsMt19937Init, 1);
  kernel.stub(KERNEL.sceKernelUtilsMt19937UInt);
  kernel.stub(KERNEL.sceKernelUtilsSha1Digest);
  kernel.stub(KERNEL.sprintf);
  kernel.stub(KERNEL.strcat);
  kernel.stub(KERNEL.strchr);
  kernel.stub(KERNEL.strcmp);
  kernel.stub(KERNEL.strcpy);
  kernel.stub(KERNEL.strlen);
  kernel.stub(KERNEL.strncmp);
  kernel.stub(KERNEL.strncpy);
  kernel.stub(KERNEL.strrchr);
  kernel.stub(KERNEL.strstr);
  kernel.stub(KERNEL.strtol);
  kernel.stub(KERNEL.toupper);
  // ── Stubs: SYSMEM ──────────────────────────────────────────────────────────
  kernel.stub(SYSMEM.SysMemUserForUser_945E45DA);
  kernel.stub(SYSMEM.SysMemUserForUser_ACBD88CA);
  kernel.stub(SYSMEM.SysMemUserForUser_D8DE5C1E);
  kernel.stub(SYSMEM.sceKernelGetPTRIG);
  kernel.stub(SYSMEM.sceKernelQueryMemoryInfo);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion395);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion401_402);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion500_505);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion507);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion600_602);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion606);
  kernel.stub(SYSMEM.sceKernelSetPTRIG);
  kernel.stub(SYSMEM.sceKernelSetUsersystemLibWork);

  // ── MD5 ──────────────────────────────────────────────────────────
  kernel.stub(MD5.sceMd5BlockInit, 1);
  kernel.stub(MD5.sceMd5BlockResult);
  kernel.stub(MD5.sceMd5BlockUpdate);
  kernel.stub(MD5.sceMd5Digest);
  // ── SHA256 ──────────────────────────────────────────────────────────
  kernel.stub(SHA256.sceSha256Digest);
  // ── ADLER ──────────────────────────────────────────────────────────
  kernel.stub(ADLER.sceAdler32);
  // ── CHNNLSV ──────────────────────────────────────────────────────────
  kernel.stub(CHNNLSV.sceSdCleanList);
  kernel.stub(CHNNLSV.sceSdCreateList, 1);
  kernel.stub(CHNNLSV.sceSdGetLastIndex);
  kernel.stub(CHNNLSV.sceSdRemoveValue);
  kernel.stub(CHNNLSV.sceSdSetIndex);
  kernel.stub(CHNNLSV.sceSdSetMember);
  kernel.stub(CHNNLSV.sceUtilsBufferCopyByPollingWithRange);
  kernel.stub(CHNNLSV.sceUtilsBufferCopyWithRange);
  // ── MT19937 ──────────────────────────────────────────────────────────
  kernel.stub(MT19937.sceMt19937Init, 1);
  kernel.stub(MT19937.sceMt19937UInt);
  // ── SFMT19937 ──────────────────────────────────────────────────────────
  kernel.stub(SFMT19937.sceSfmt19937FillArray32);
  kernel.stub(SFMT19937.sceSfmt19937FillArray64);
  kernel.stub(SFMT19937.sceSfmt19937GenRand32);
  kernel.stub(SFMT19937.sceSfmt19937GenRand64);
  kernel.stub(SFMT19937.sceSfmt19937InitByArray, 1);
  kernel.stub(SFMT19937.sceSfmt19937InitGenRand, 1);

  log.info("Thread HLE handlers registered");
}
