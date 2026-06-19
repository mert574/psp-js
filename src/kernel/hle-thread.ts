/**
 * HLE thread management handlers for sceKernelThread*, module management,
 * callbacks, interrupt stubs, and timing functions.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { ThreadState, WaitType, type ThreadContext, type PSPCallback, type LoadedModule } from "./hle-kernel.js";
import { THREAD, KERNEL, SYSMEM, ADLER, CHNNLSV, MD5, MT19937, SFMT19937, SHA256 } from "./nids.js";
import { loadElf, computeElfMemorySize } from "../loader/elf.js";

// Module names that we HLE — matching PPSSPP's ShouldHLEModule() list.
// When a PRX with one of these modnames is loaded, we fake it instead of executing native code.
const HLE_MODULE_NAMES = new Set([
  "sceATRAC3plus_Library", "sceAtrac3plus", "sceAudiocodec_Driver",
  "sceMpeg_library", "scePsmf_library", "scePsmfP_library", "scePsmfPlayer",
  "sceSAScore", "sceSasCore", "libsas",
  "sceAudio_Driver", "sceAudio",
  "sceNet_Library", "sceNetInet_Library", "sceNetApctl_Library",
  "sceNetAdhoc_Library", "sceNetAdhocctl_Library", "sceNetAdhocMatching_Library",
  "sceNetResolver_Library", "sceNet_Service",
  "sceFont_Library", "sceLibFont",
  "sceSsl_Module", "sceParseHTTPheader_Library", "sceParseUri_Library",
  "sceHttp_Library", "sceHttps_Module",
  "sceDeflt", "sceNpDrm_user_Module", "sceNp",
  "sceOpenPSID_Library", "scePauth_Module",
  "sceMp3_Library", "sceAac_Library",
  "sceP3da_Library", "sceGameUpdate_Library",
]);

/** Peek at the module name from an ELF's module_info without fully loading it. */
function peekElfModuleName(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = data[5] === 1;
  const eType = view.getUint16(0x10, le);
  if (eType !== 0xFFA0) return null; // not a PRX

  const phoff = view.getUint32(0x1c, le);
  const phnum = view.getUint16(0x2c, le);
  if (phnum === 0) return null;

  const pPaddr  = view.getUint32(phoff + 0x0c, le);
  const pOffset = view.getUint32(phoff + 0x04, le);
  // moduleinfo is at file_offset = pOffset + (pPaddr - pVaddr) for PRX
  const miOff = pOffset + (pPaddr & 0x7FFFFFFF);
  if (miOff + 0x20 > data.byteLength) return null;

  // Module name at offset 0x04 within SceModuleInfo, 28 bytes
  let name = "";
  for (let i = 0; i < 28; i++) {
    const b = data[miOff + 0x04 + i]!;
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  return name || null;
}

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
      // "Alive" = could still run again (running/ready/waiting). DORMANT threads
      // (exited or never-started) and DEAD ones can't run on their own, so they
      // don't keep the CPU loop alive.
      const anyAlive = [...kernel.threads.values()].some(
        (th) => th.state !== ThreadState.DEAD && th.state !== ThreadState.DORMANT,
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

  // sceKernelExitDeleteThread — also frees the stack (PPSSPP __KernelDeleteThread
  // → Cleanup() → FreeStack()). The thread entry stays as DEAD so waiters/exit
  // status queries keep working; a later DeleteThread double-free is a no-op.
  kernel.register(THREAD.sceKernelExitDeleteThread, (regs) => {
    const t = kernel.threads.get(kernel.currentThreadId);
    exitThread(regs);
    if (t) kernel.userMemory.free(t.stackBase);
  });
  // sceKernelExitThread
  kernel.register(THREAD.sceKernelExitThread, exitThread);

  // ── Sleep / Delay ────────────────────────────────────────────────────

  const sleepThread = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    // Waiting is illegal in interrupt/GE-callback context — blocking would save
    // mid-callback CPU state into the thread context and corrupt it on wake.
    if (kernel.inInterrupt) {
      regs.setGpr(2, 0x800201a7); // SCE_KERNEL_ERROR_CAN_NOT_WAIT
      return;
    }
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      // PPSSPP __KernelSleepThread: a wakeup that arrived before we slept is
      // remembered as wakeupCount — consume it and return without blocking.
      if (t.wakeupCount > 0) {
        t.wakeupCount--;
        regs.setGpr(2, 0);
        return;
      }
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.SLEEP;
      t.isProcessingCallbacks = false; // per-wait; CB wrapper re-enables
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  };

  const delayThread = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const usec = regs.getGpr(4);
    // Waiting is illegal in interrupt/GE-callback context (see sleepThread)
    if (kernel.inInterrupt) {
      regs.setGpr(2, 0x800201a7); // SCE_KERNEL_ERROR_CAN_NOT_WAIT
      return;
    }
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state    = ThreadState.WAITING;
      t.waitType = WaitType.DELAY;
      t.isProcessingCallbacks = false; // per-wait; CB wrapper re-enables
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
    sleepThread(regs);
    if (t && t.state === ThreadState.WAITING) t.isProcessingCallbacks = true;
  };
  const delayThreadCB = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const t = kernel.threads.get(kernel.currentThreadId);
    delayThread(regs);
    if (t && t.state === ThreadState.WAITING) t.isProcessingCallbacks = true;
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

    // Allocate from userMemory (same pool as sceKernelAllocPartitionMemory)
    // PPSSPP sceKernelThread.cpp:334 — StackAllocator() returns userMemory, fromTop=true
    // Auto-init userMemory if not yet initialized (e.g., raw boot tests without setHeapBase)
    if (!kernel.userMemory.isInitialized()) {
      kernel.userMemory.init(0x08800000, 0x0C000000 - 0x08800000);
    }
    const stackBase = kernel.userMemory.alloc(aligned, true, `stack/thread${tid}`);
    if (stackBase === -1) {
      log.error(`sceKernelCreateThread: stack allocation failed`);
      regs.setGpr(2, -1);
      return;
    }

    // Stack layout matching PPSSPP sceKernelThread.cpp:328-366:
    // [stackBase, stackBase+aligned) = entire stack allocation
    // SP = stackBase + aligned, then SP -= 256 for k0 area
    // Fill + k0 setup happens in sceKernelStartThread (FillStack)
    const sp = (stackBase + aligned) >>> 0;
    const k0 = (sp - 0x100) >>> 0;

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
      id: tid, entry, stackSize: aligned, stackBase, stackTop: k0, k0,
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
      waitFplId: 0,
      waitFplDataPtr: 0,
      waitVplId: 0,
      waitVplSize: 0,
      waitVplAddrPtr: 0,
      pendingWakeCallback: undefined as (() => void) | undefined,
      cbPromotedFromWaitType: WaitType.NONE,
    };

    kernel.threads.set(tid, thread);
    log.info(`sceKernelCreateThread(entry=0x${entry.toString(16)}, stack=${stackSize}, sp=0x${sp.toString(16)}) → tid=${tid}`);
    regs.setGpr(2, tid);
  });

  // sceKernelStartThread(thid, arglen, argp)
  kernel.register(THREAD.sceKernelStartThread, (regs) => {
    // PPSSPP: HLE_NOT_IN_INTERRUPT flag (sceKernel.cpp:772)
    if (kernel.inInterrupt) {
      regs.setGpr(2, 0x80020064); // SCE_KERNEL_ERROR_ILLEGAL_CONTEXT
      return;
    }
    const thid   = regs.getGpr(4);
    const arglen = regs.getGpr(5);
    const argp   = regs.getGpr(6) >>> 0;
    const thread = kernel.threads.get(thid);
    if (thread) {
      // PPSSPP __KernelResetThread: reset context before starting
      resetThreadContext(thread.context);

      // FillStack — PPSSPP sceKernelThread.cpp:348-366 (called from __KernelStartThread)
      const bus = kernel.bus;
      // Fill entire stack with 0xFF
      for (let i = 0; i < thread.stackSize; i += 4) {
        bus.writeU32(thread.stackBase + i, 0xFFFFFFFF);
      }
      // Zero k0 area (top 256 bytes of stack)
      for (let i = 0; i < 0x100; i += 4) {
        bus.writeU32(thread.k0 + i, 0);
      }
      // Write k0 fields
      bus.writeU32(thread.k0 + 0xC0, thread.id);
      bus.writeU32(thread.k0 + 0xC8, thread.stackBase); // initialStack
      bus.writeU32(thread.k0 + 0xF8, 0xFFFFFFFF);
      bus.writeU32(thread.k0 + 0xFC, 0xFFFFFFFF);
      // Write thread UID at initialStack
      bus.writeU32(thread.stackBase, thread.id);

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

      // Set the caller's return value BEFORE any reschedule — reschedule saves
      // the caller's register context, so a later setGpr would write v0 into
      // the NEW thread's registers and the caller would resume with garbage.
      regs.setGpr(2, 0);

      if (kernel.currentThreadId === 0) {
        kernel.pendingThreadEntry = { entry: thread.entry, arglen, argp, sp, k0: thread.k0 };
      } else {
        // Reschedule if new thread has better (lower number) priority
        const current = kernel.threads.get(kernel.currentThreadId);
        if (current && current.priority > thread.priority) {
          kernel.reschedule(regs);
        }
      }
      return;
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
    regs.setGpr(2, 0); // set return value before any reschedule (saves caller regs)
    if (t) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.SLEEP) {
        // Thread is sleeping → wake it. Higher-priority wakee preempts via reschedule.
        t.state    = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
        kernel.reschedule(regs);
      } else {
        // Not sleeping yet → remember the wakeup (PPSSPP wakeupCount++).
        t.wakeupCount++;
      }
    }
  });

  // sceKernelGetThreadExitStatus(thid)
  kernel.register(THREAD.sceKernelGetThreadExitStatus, (regs) => {
    const thid = regs.getGpr(4);
    const t    = kernel.threads.get(thid);
    if (t && t.state === ThreadState.DORMANT) {
      regs.setGpr(2, 0); // dormant (incl. exited) → report exit status (0)
    } else if (t) {
      regs.setGpr(2, 0x800201a4 >>> 0); // SCE_KERNEL_ERROR_NOT_DORMANT
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
      cur.isProcessingCallbacks = false; // per-wait; CB variant sets true
      kernel.saveContext(cur, regs);
      cur.context.gpr[2] = 0; // v0 = 0 when we wake
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    }
  });

  // sceKernelDeleteThread(thid)
  kernel.register(THREAD.sceKernelDeleteThread, (regs) => {
    const t = kernel.threads.get(regs.getGpr(4));
    if (t) kernel.userMemory.free(t.stackBase); // PPSSPP Cleanup() → FreeStack()
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

  // System PRXes we already HLE — return fake module without loading code
  // (matches PPSSPP lieAboutSuccessModules)
  const FAKE_MODULE_NAMES: Record<string, string> = {
    "flash0:/kd/audiocodec.prx": "sceAudiocodec_Driver",
    "flash0:/kd/audiocodec_260.prx": "sceAudiocodec_Driver",
    "flash0:/kd/libatrac3plus.prx": "sceATRAC3plus_Library",
    "flash0:/kd/ifhandle.prx": "sceNet_Service",
    "flash0:/kd/pspnet.prx": "sceNet_Library",
    "flash0:/kd/pspnet_inet.prx": "sceNetInet_Library",
    "flash0:/kd/pspnet_apctl.prx": "sceNetApctl_Library",
    "flash0:/kd/pspnet_resolver.prx": "sceNetResolver_Library",
    "flash0:/kd/pspnet_adhoc.prx": "sceNetAdhoc_Library",
    "flash0:/kd/pspnet_adhocctl.prx": "sceNetAdhocctl_Library",
    "flash0:/kd/pspnet_adhoc_matching.prx": "sceNetAdhocMatching_Library",
  };

  // sceKernelLoadModule(name, flags, optionAddr) → moduleId
  kernel.register(KERNEL.sceKernelLoadModule, (regs, bus) => {
    const name = kernel.readCString(bus, regs.getGpr(4));
    const modId = kernel.nextBlockId++;

    // Check for system PRXes we already HLE
    if (FAKE_MODULE_NAMES[name]) {
      const mod: LoadedModule = {
        id: modId, name: FAKE_MODULE_NAMES[name]!, path: name,
        entryAddr: 0, gp: 0, baseAddr: 0, size: 0, isFake: true, status: 0,
      };
      kernel.loadedModules.set(modId, mod);
      log.info(`sceKernelLoadModule("${name}") → fake 0x${modId.toString(16)}`);
      regs.setGpr(2, modId);
      return;
    }

    // Read file from virtual filesystem
    const fileData = kernel.pspFs.getFileData(name, kernel.currentThreadId);
    if (!fileData) {
      log.warn(`sceKernelLoadModule("${name}"): file not found`);
      regs.setGpr(2, 0x80020002); // SCE_KERNEL_ERROR_ERRNO_FILE_NOT_FOUND
      return;
    }

    // Check ELF magic (file should be pre-decrypted/decompressed at boot)
    if (fileData.byteLength < 4) {
      log.warn(`sceKernelLoadModule("${name}"): file too small`);
      regs.setGpr(2, 0x80020001); // SCE_KERNEL_ERROR_FILEERR
      return;
    }
    const elfMagic = new DataView(fileData.buffer, fileData.byteOffset, 4).getUint32(0, false);

    // PPSSPP: ShouldHLEModule(head->modname) — check module name from ~PSP header
    // or ELF module_info. If it matches a known HLE module, fake it.
    let hleModName: string | null = null;
    if (elfMagic === 0x7e505350 && fileData.byteLength > 0x2A) {
      // Read modname from ~PSP header at offset 0x0A (28 bytes)
      let mn = "";
      for (let i = 0; i < 28; i++) {
        const b = fileData[0x0A + i]!;
        if (b === 0) break;
        mn += String.fromCharCode(b);
      }
      if (mn && HLE_MODULE_NAMES.has(mn)) hleModName = mn;
    } else if (elfMagic === 0x7f454c46) {
      const mn = peekElfModuleName(fileData);
      if (mn && HLE_MODULE_NAMES.has(mn)) hleModName = mn;
    }
    if (hleModName) {
      log.info(`sceKernelLoadModule("${name}"): HLE module "${hleModName}", creating fake`);
      const mod: LoadedModule = {
        id: modId, name: hleModName, path: name,
        entryAddr: 0, gp: 0, baseAddr: 0, size: 0, isFake: true, status: 0,
      };
      kernel.loadedModules.set(modId, mod);
      regs.setGpr(2, modId);
      return;
    }

    if (elfMagic !== 0x7f454c46) {
      // Not a valid ELF — might be encrypted but decryption failed. Return fake module.
      log.warn(`sceKernelLoadModule("${name}"): not an ELF (magic=0x${elfMagic.toString(16)}), creating fake module`);
      const mod: LoadedModule = {
        id: modId, name, path: name,
        entryAddr: 0, gp: 0, baseAddr: 0, size: 0, isFake: true, status: 0,
      };
      kernel.loadedModules.set(modId, mod);
      regs.setGpr(2, modId);
      return;
    }

    // Compute memory needed and allocate
    const memSize = computeElfMemorySize(fileData);
    const loadAddr = kernel.userMemory.alloc(memSize || 0x10000, false, `module/${name}`);
    if (loadAddr === -1) {
      log.error(`sceKernelLoadModule("${name}"): memory allocation failed`);
      regs.setGpr(2, 0x800200d9); // SCE_KERNEL_ERROR_MEMBLOCK_ALLOC_FAILED
      return;
    }

    // Load ELF at the allocated address with the next available syscall codes
    const result = loadElf(fileData, bus, loadAddr, kernel.nextSyscallCode);
    kernel.nextSyscallCode = result.nextSyscallCode;

    // Wire up HLE handlers for the module's imports
    const unimplCount = kernel.remapSyscallsAdditive(result.nidBySyscall);

    // If the module has unimplemented imports, don't run its native code —
    // it would call unimplemented syscalls and crash/hang. Fake it instead.
    // This matches PPSSPP's behavior: ShouldHLEModule() prevents native execution.
    const shouldFake = unimplCount > 0;
    if (shouldFake) {
      log.info(`sceKernelLoadModule("${name}"): ${unimplCount} unimplemented imports, faking module`);
    }

    const mod: LoadedModule = {
      id: modId,
      name: result.moduleName || name,
      path: name,
      entryAddr: result.moduleStartFunc ?? result.entryPoint,
      gp: result.gp,
      baseAddr: loadAddr,
      size: memSize,
      isFake: shouldFake,
      status: 0,
    };
    kernel.loadedModules.set(modId, mod);

    log.info(`sceKernelLoadModule("${name}") → 0x${modId.toString(16)} loaded at 0x${loadAddr.toString(16)} entry=0x${mod.entryAddr.toString(16)}`);
    regs.setGpr(2, modId);
  });

  // sceKernelLoadModuleByID — load by file descriptor (less common)
  kernel.register(KERNEL.sceKernelLoadModuleByID, (regs) => {
    const modId = kernel.nextBlockId++;
    log.info(`sceKernelLoadModuleByID(fd=${regs.getGpr(4)}) → fake 0x${modId.toString(16)}`);
    const mod: LoadedModule = {
      id: modId, name: "unknown", path: "byID",
      entryAddr: 0, gp: 0, baseAddr: 0, size: 0, isFake: true, status: 0,
    };
    kernel.loadedModules.set(modId, mod);
    regs.setGpr(2, modId);
  });

  // sceKernelStartModule(moduleId, argsize, argp, returnValueAddr, optionAddr) → moduleId
  kernel.register(KERNEL.sceKernelStartModule, (regs, bus) => {
    const moduleId = regs.getGpr(4);
    const argsize = regs.getGpr(5);
    const argp = regs.getGpr(6);

    const mod = kernel.loadedModules.get(moduleId);
    if (!mod) {
      log.warn(`sceKernelStartModule: unknown module 0x${moduleId.toString(16)}`);
      regs.setGpr(2, 0x80020032); // SCE_KERNEL_ERROR_UNKNOWN_MODULE
      return;
    }

    if (mod.isFake || mod.entryAddr === 0) {
      mod.status = 1;
      log.info(`sceKernelStartModule(0x${moduleId.toString(16)} "${mod.name}") → fake/no-entry, returning success`);
      regs.setGpr(2, 0);
      return;
    }

    // Create a thread to run module_start, same pattern as sceKernelCreateThread
    const tid = kernel.nextBlockId++;
    const stackSize = 0x4000;
    const aligned = (stackSize + 0xFF) & ~0xFF;
    const stackBase = kernel.userMemory.alloc(aligned, true, `stack/module_start`);
    if (stackBase === -1) { log.error("module_start: stack alloc failed"); regs.setGpr(2, -1); return; }
    const sp = (stackBase + aligned) >>> 0;
    const k0 = (sp - 0x100) >>> 0;

    // FillStack — this is a module_start thread, fill immediately (started right away)
    for (let i = 0; i < aligned; i += 4) bus.writeU32(stackBase + i, 0xFFFFFFFF);
    for (let i = 0; i < 0x100; i += 4) bus.writeU32(k0 + i, 0);
    bus.writeU32(k0 + 0xC0, tid);
    bus.writeU32(k0 + 0xC8, stackBase);
    bus.writeU32(k0 + 0xF8, 0xFFFFFFFF);
    bus.writeU32(k0 + 0xFC, 0xFFFFFFFF);
    bus.writeU32(stackBase, tid);

    const ctx: ThreadContext = {
      gpr: new Uint32Array(32), hi: 0, lo: 0, pc: mod.entryAddr,
      fpr: new Uint32Array(32), fcr31: 0,
      vfpr: new Float32Array(128), vfpuCtrl: new Uint32Array(16), vfpuCc: 0,
      vpfxs: 0, vpfxt: 0, vpfxd: 0,
      vpfxsEnabled: false, vpfxtEnabled: false, vpfxdEnabled: false,
    };
    resetThreadContext(ctx);
    ctx.pc = mod.entryAddr;
    ctx.gpr[26] = k0;         // $k0
    ctx.gpr[28] = mod.gp;     // $gp
    ctx.gpr[29] = k0 - 64;   // $sp (below k0 area)
    ctx.gpr[30] = k0 - 64;   // $fp
    ctx.gpr[31] = kernel.threadReturnAddr; // $ra → trampoline

    // Pass args: a0 = argsize, a1 = argp
    if (argsize > 0 && argp !== 0) {
      const argDst = k0 - 64 - ((argsize + 0xf) & ~0xf);
      for (let i = 0; i < argsize; i++) bus.writeU8(argDst + i, bus.readU8(argp + i));
      ctx.gpr[4] = argsize;
      ctx.gpr[5] = argDst;
      ctx.gpr[29] = argDst - 64;
      ctx.gpr[30] = argDst - 64;
    } else {
      ctx.gpr[4] = 0;
      ctx.gpr[5] = 0;
    }

    kernel.threads.set(tid, {
      id: tid, entry: mod.entryAddr,
      stackSize: aligned, stackBase, stackTop: k0, k0,
      priority: 0x20,
      state: ThreadState.READY, waitType: WaitType.NONE,
      context: ctx,
      wakeupCount: 0,
      callbacks: [],
      isProcessingCallbacks: false,
      waitSemaId: 0, waitSemaCount: 0,
      waitEvfId: 0, waitEvfBits: 0, waitEvfMode: 0, waitEvfOutPtr: 0,
      waitGeListId: 0, waitDeadlineVbl: 0, waitWakeTimeMs: 0,
      waitThreadEndId: 0, waitMutexId: 0, waitMutexCount: 0,
      waitFplId: 0, waitFplDataPtr: 0,
      waitVplId: 0, waitVplSize: 0, waitVplAddrPtr: 0,
      pendingWakeCallback: undefined,
      cbPromotedFromWaitType: WaitType.NONE,
    });

    mod.status = 1;
    log.info(`sceKernelStartModule(0x${moduleId.toString(16)} "${mod.name}") → thread ${tid} at 0x${mod.entryAddr.toString(16)}`);

    // Let the module_start thread run. It will return via the thread-return trampoline
    // and be cleaned up. The calling thread continues after scheduler gives it time.
    if (!kernel.reschedule(regs)) kernel.idleBreak = true;
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
      // PPSSPP: after notifying, calls __KernelCheckCallbacks which reschedules
      // to let the target thread (if in CB-wait) run its callback.
      // Our reschedule() already promotes WAITING threads with pending callbacks.
      // v0 must be set BEFORE reschedule so it lands in the caller's saved context.
      regs.setGpr(2, 0);
      kernel.reschedule(regs);
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
  // PPSSPP: sets RETURN(1) BEFORE calling __KernelForceCallbacks so that
  // the saved $v0 (in the MipsCall frame) is 1.  If no callbacks were
  // dispatched, overwrite with 0.
  kernel.register(KERNEL.sceKernelCheckCallback, (regs) => {
    // Pre-set v0=1 so the MipsCall save captures it (PPSSPP line 3379)
    regs.setGpr(2, 1);
    const processed = kernel.processThreadCallbacks(regs, true);
    if (!processed) {
      regs.setGpr(2, 0);
    }
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
    const ct = kernel.coreTiming;
    if (!ct) return 0n;
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

  const subIntrs = kernel.subIntrs; // key = intrNumber * 32 + subIntrNumber

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
    const prev = kernel.interruptsEnabled ? 1 : 0;
    kernel.interruptsEnabled = false;
    regs.setGpr(2, prev);
  });

  // sceKernelCpuResumeIntr(flags) / sceKernelCpuResumeIntrWithSync(flags)
  const resumeIntr = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const flags = regs.getGpr(4);
    // flags contains the value returned by SuspendIntr; if it was 1 (interrupts were on), re-enable
    if (flags === 1) {
      kernel.interruptsEnabled = true;
      // Process any alarm fires that were deferred while interrupts were off
      let firedAlarm = false;
      while (kernel.pendingAlarmFires.length > 0) {
        const alarmId = kernel.pendingAlarmFires.shift()!;
        if (kernel.processAlarmFire) {
          kernel.processAlarmFire(alarmId);
          firedAlarm = true;
        }
      }
      // After processing deferred interrupts, check if a higher-priority thread
      // became READY and should preempt the current thread (like PSP interrupt exit).
      // Save return value first since reschedule changes the register context.
      if (firedAlarm) {
        const cur = kernel.threads.get(kernel.currentThreadId);
        if (cur) {
          let shouldReschedule = false;
          for (const t of kernel.threads.values()) {
            if (t.state === ThreadState.READY && t.priority < cur.priority) {
              shouldReschedule = true;
              break;
            }
          }
          if (shouldReschedule) {
            // Set v0=0 for ResumeIntr return value before saving context
            regs.setGpr(2, 0);
            kernel.reschedule(regs);
            return;
          }
        }
      }
    }
    regs.setGpr(2, 0);
  };
  kernel.register(KERNEL.sceKernelCpuResumeIntr, resumeIntr);
  kernel.register(KERNEL.sceKernelCpuResumeIntrWithSync, resumeIntr);

  // sceKernelIsCpuIntrEnable() → real interrupt state (PPSSPP sceKernelInterrupt.cpp:115
  // returns __InterruptsEnabled()). Games poll this inside spinlocks/critical
  // sections; a constant 1 makes those loops misbehave.
  kernel.register(KERNEL.sceKernelIsCpuIntrEnable, (regs) => {
    regs.setGpr(2, kernel.interruptsEnabled ? 1 : 0);
  });

  // sceKernelSuspendDispatchThread() → previous dispatch state (PPSSPP
  // sceKernelThread.cpp:2108). Disables thread switching so the caller runs a
  // critical section without being preempted; returns the old dispatch flag the
  // caller passes back to ResumeDispatchThread. Errors if interrupts are off.
  kernel.register(KERNEL.sceKernelSuspendDispatchThread, (regs) => {
    if (!kernel.interruptsEnabled) { regs.setGpr(2, 0x80020066); return; } // SCE_KERNEL_ERROR_CPUDI
    const prev = kernel.dispatchEnabled ? 1 : 0;
    kernel.dispatchEnabled = false;
    regs.setGpr(2, prev);
  });

  // sceKernelResumeDispatchThread(enabled) (PPSSPP sceKernelThread.cpp:2119) —
  // restore dispatch to the passed state and reschedule. Errors if interrupts off.
  kernel.register(KERNEL.sceKernelResumeDispatchThread, (regs) => {
    if (!kernel.interruptsEnabled) { regs.setGpr(2, 0x80020066); return; }
    kernel.dispatchEnabled = regs.getGpr(4) !== 0;
    regs.setGpr(2, 0);
    if (kernel.dispatchEnabled) kernel.preemptIfHigherPriorityReady(regs);
  });

  // sceKernelGetThreadmanIdList(type, readBufPtr, readBufSize, idCountPtr) — PPSSPP
  // sceKernelThread.cpp:1258. Lists the UIDs of kernel objects of `type` into the
  // buffer (readBufSize = max id COUNT, not bytes), writes the full total to
  // idCountPtr, returns min(total, readBufSize). Types 1-14 are object kinds;
  // 64-67 filter threads by run state. We only track some object kinds — valid but
  // untracked kinds list as empty; an out-of-range type is ILLEGAL_TYPE.
  kernel.register(KERNEL.sceKernelGetThreadmanIdList, (regs, bus) => {
    const type = regs.getGpr(4) >>> 0;
    const readBufPtr = regs.getGpr(5) >>> 0;
    const readBufSize = regs.getGpr(6) >>> 0;
    const idCountPtr = regs.getGpr(7) >>> 0;
    if (readBufSize >= 0x8000000) { regs.setGpr(2, 0x800200d3); return; } // ILLEGAL_ADDR

    const threadsWith = (pred: (t: { state: ThreadState; waitType: WaitType }) => boolean): number[] => {
      const out: number[] = [];
      for (const [id, t] of kernel.threads) if (pred(t)) out.push(id);
      return out;
    };
    let ids: number[];
    switch (type) {
      case 1:  ids = [...kernel.threads.keys()]; break;      // TMID_Thread
      case 2:  ids = [...kernel.semaphores.keys()]; break;   // TMID_Semaphore
      case 3:  ids = [...kernel.eventFlags.keys()]; break;   // TMID_EventFlag
      case 6:  ids = [...kernel.fplPools.keys()]; break;     // TMID_Fpl
      case 8:  ids = [...kernel.pspCallbacks.keys()]; break; // TMID_Callback
      case 64: ids = threadsWith(t => t.state === ThreadState.WAITING && t.waitType === WaitType.SLEEP); break;
      case 65: ids = threadsWith(t => t.state === ThreadState.WAITING && t.waitType === WaitType.DELAY); break;
      case 66: ids = []; break; // TMID_SuspendThread — suspension isn't modeled
      case 67: ids = threadsWith(t => t.state === ThreadState.DORMANT); break;
      // Valid object kinds we don't track separately → empty list.
      case 4: case 5: case 7: case 9: case 10: case 11: case 12: case 13: case 14:
        ids = []; break;
      default: regs.setGpr(2, 0x800201bb); return; // ILLEGAL_TYPE
    }

    const writeCount = Math.min(ids.length, readBufSize);
    if (readBufPtr !== 0) {
      for (let i = 0; i < writeCount; i++) bus.writeU32(readBufPtr + i * 4, ids[i]!);
    }
    if (idCountPtr !== 0) bus.writeU32(idCountPtr, ids.length);
    regs.setGpr(2, writeCount);
  });

  // sceKernelReferThreadStatus — PPSSPP sceKernelThread.cpp: fill SceKernelThreadInfo struct
  kernel.register(THREAD.sceKernelReferThreadStatus, (regs, bus) => {
    let thid = regs.getGpr(4);
    const statusPtr = regs.getGpr(5);
    if (thid === 0) thid = kernel.currentThreadId;
    const t = kernel.threads.get(thid);
    if (!t) { regs.setGpr(2, 0x800201bc); return; } // SCE_KERNEL_ERROR_UNKNOWN_THID
    if (statusPtr !== 0) {
      // Fill SceKernelThreadInfo struct matching PPSSPP NativeThread layout
      // (see sceKernelThread.h:154)
      bus.writeU32(statusPtr + 40, t.state);                        // status
      bus.writeU32(statusPtr + 44, t.entry);                        // entrypoint
      // stack — PPSSPP: initialStack = currentStack.start (base address)
      // On real PSP, memory below this is 0xFF (pre-filled stack pool).
      bus.writeU32(statusPtr + 48, t.stackBase);
      bus.writeU32(statusPtr + 52, t.stackSize);                    // stackSize
      bus.writeU32(statusPtr + 56, t.context.gpr[28] ?? 0);        // gpReg ($gp)
      bus.writeU32(statusPtr + 60, t.priority);                     // initialPriority
      bus.writeU32(statusPtr + 64, t.priority);                     // currentPriority
      bus.writeU32(statusPtr + 68, t.waitType);                     // waitType
      bus.writeU32(statusPtr + 76, t.wakeupCount);                  // wakeupCount
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
    // PPSSPP sceKernelThread.cpp:2219-2220 — only an error on newer SDKs
    if (kernel.inInterrupt && kernel.compiledSdkVersion >= 0x03080000) {
      regs.setGpr(2, 0x80020064); // SCE_KERNEL_ERROR_ILLEGAL_CONTEXT
      return;
    }
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
    t.state = ThreadState.DORMANT;
    kernel.userMemory.free(t.stackBase); // PPSSPP Cleanup() → FreeStack()
    kernel.threads.delete(thid);
    regs.setGpr(2, 0);
  });

  // ── Alarms ──────────────────────────────────────────────────────────────────

  // Alarm tracking: alarmId → { handlerPtr, commonPtr }
  interface AlarmEntry {
    handlerPtr: number;
    commonPtr: number;
  }
  const alarms = new Map<number, AlarmEntry>();
  let nextAlarmId = 1;

  // CoreTiming event type for alarm — registered lazily (coreTiming is null at HLE init time)
  let alarmEventId: number = -1;

  /** Fire an alarm handler: invoke the guest function and handle rescheduling. */
  function fireAlarm(alarmId: number): void {
    const alarm = alarms.get(alarmId);
    if (!alarm) return;

    // Invoke the alarm handler as a guest function using the mini-CPU-loop pattern.
    // The handler receives: a0 = commonPtr.
    // It returns a value in v0: >0 means reschedule after that many microseconds, 0 means done.
    // Per PPSSPP, the alarm handler runs in interrupt context (not any game thread),
    // so temporarily clear currentThreadId so sceKernelGetThreadId returns a non-matching value.
    const savedThreadId = kernel.currentThreadId;
    kernel.currentThreadId = -1;
    kernel._invokeGeCb(alarm.handlerPtr, alarm.commonPtr, 0);
    kernel.currentThreadId = savedThreadId;

    // Read return value ($v0) captured by _invokeGeCb before register restoration
    const retVal = kernel.lastGuestCallReturnValue;

    if (retVal > 0 && kernel.coreTiming) {
      // Reschedule the alarm for retVal more microseconds
      const cycles = kernel.coreTiming.usToCycles(retVal);
      kernel.coreTiming.scheduleEvent(cycles, alarmEventId, alarmId);
    } else {
      // Alarm is done — remove it
      alarms.delete(alarmId);
    }
  }

  // Wire up the processAlarmFire callback so sceKernelCpuResumeIntr can use it
  kernel.processAlarmFire = fireAlarm;

  /** Ensure the alarm CoreTiming event type is registered. */
  function ensureAlarmEvent(): number {
    if (alarmEventId >= 0 || !kernel.coreTiming) return alarmEventId;
    alarmEventId = kernel.coreTiming.registerEventType("Alarm", (_cyclesLate, alarmId) => {
      const alarm = alarms.get(alarmId);
      if (!alarm) return;

      if (!kernel.interruptsEnabled) {
        // Defer alarm handler until interrupts are re-enabled
        kernel.pendingAlarmFires.push(alarmId);
        return;
      }

      fireAlarm(alarmId);
    });
    return alarmEventId;
  }
  // Register the Alarm event type eagerly once CoreTiming exists, so a save
  // state taken with an alarm pending still remaps that event by name after a
  // fresh boot (CoreTiming.deserialize drops events whose type isn't registered).
  kernel.onTimingReady(() => { ensureAlarmEvent(); });

  // Save the alarm table so a restored Alarm event has data to fire against.
  // Without this the remapped event fires into an empty map and the guest
  // handler silently never runs. (The scheduled event itself is in CoreTiming.)
  kernel.registerStateModule("alarm", {
    save: () => ({ alarms: [...alarms.entries()], nextAlarmId }),
    load: (data) => {
      const d = data as { alarms: [number, AlarmEntry][]; nextAlarmId: number };
      alarms.clear();
      for (const [k, v] of d.alarms) alarms.set(k, { ...v });
      nextAlarmId = d.nextAlarmId;
    },
  });

  // sceKernelSetAlarm(clock, handler, common) → alarmId
  kernel.register(KERNEL.sceKernelSetAlarm, (regs) => {
    const clock = regs.getGpr(4);      // microseconds
    const handlerPtr = regs.getGpr(5);
    const commonPtr = regs.getGpr(6);

    const alarmId = nextAlarmId++;
    alarms.set(alarmId, { handlerPtr, commonPtr });

    const evId = ensureAlarmEvent();
    if (kernel.coreTiming && evId >= 0) {
      const cycles = kernel.coreTiming.usToCycles(Math.max(0, clock));
      kernel.coreTiming.scheduleEvent(cycles, evId, alarmId);
    }

    log.info(`sceKernelSetAlarm(clock=${clock}, handler=0x${handlerPtr.toString(16)}, common=0x${commonPtr.toString(16)}) → ${alarmId}`);
    regs.setGpr(2, alarmId);
  });

  // sceKernelCancelAlarm(alarmId) → 0 on success, error if not found
  kernel.register(KERNEL.sceKernelCancelAlarm, (regs) => {
    const alarmId = regs.getGpr(4);
    const alarm = alarms.get(alarmId);
    if (!alarm) {
      regs.setGpr(2, 0x800200b4 >>> 0); // SCE_KERNEL_ERROR_UNKNOWN_ALMID
      return;
    }

    // Unschedule the CoreTiming event and remove alarm entry
    if (kernel.coreTiming && alarmEventId >= 0) {
      kernel.coreTiming.unscheduleEvent(alarmEventId, alarmId);
    }
    alarms.delete(alarmId);
    log.info(`sceKernelCancelAlarm(${alarmId}) → 0`);
    regs.setGpr(2, 0);
  });

  // sceKernelRotateThreadReadyQueue(priority) — PPSSPP sceKernelThread.cpp:2137/2161.
  // Moves the head of the ready queue at `priority` to the back, then reschedules, so
  // the next thread of that priority gets the CPU (round-robin). priority 0 means "my
  // own priority". Games busy-call this to hand off to a sibling thread (Wipeout's
  // loop does); the old stub returned 0 without yielding, so the caller spun forever
  // and the game hung. We set v0 first, then yield to another same-or-higher thread
  // (PPSSPP only switches to a thread at >= the rotated priority).
  kernel.register(THREAD.sceKernelRotateThreadReadyQueue, (regs) => {
    let priority = regs.getGpr(4) | 0;
    const cur = kernel.threads.get(kernel.currentThreadId);
    if (priority === 0 && cur) priority = cur.priority;
    if (priority <= 0x07 || priority > 0x77) {
      regs.setGpr(2, 0x80020193); // SCE_KERNEL_ERROR_ILLEGAL_PRIORITY
      return;
    }
    regs.setGpr(2, 0); // set return value before yielding (yielding thread resumes with it)
    kernel.yieldToOtherThread(regs, priority);
  });

  // ── Stubs: THREAD ──────────────────────────────────────────────────────────
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

  // ── MD5 / SHA1 hash utilities ───────────────────────────────────────────────
  // Pure-JS MD5 implementation (RFC 1321)
  const md5State = { buf: new Uint8Array(0), h: new Uint32Array(4), len: 0 };
  function md5Init() {
    md5State.h[0] = 0x67452301; md5State.h[1] = 0xefcdab89;
    md5State.h[2] = 0x98badcfe; md5State.h[3] = 0x10325476;
    md5State.buf = new Uint8Array(0); md5State.len = 0;
  }
  function md5Update(data: Uint8Array) {
    const combined = new Uint8Array(md5State.buf.length + data.length);
    combined.set(md5State.buf); combined.set(data, md5State.buf.length);
    md5State.len += data.length;
    let offset = 0;
    while (offset + 64 <= combined.length) {
      md5Transform(md5State.h, combined.subarray(offset, offset + 64));
      offset += 64;
    }
    md5State.buf = combined.slice(offset);
  }
  function md5Finish(): Uint8Array {
    const totalBits = BigInt(md5State.len) * 8n;
    const padLen = (55 - md5State.buf.length % 64 + 64) % 64 + 1;
    const padded = new Uint8Array(md5State.buf.length + padLen + 8);
    padded.set(md5State.buf);
    padded[md5State.buf.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Number(totalBits & 0xffffffffn), true);
    view.setUint32(padded.length - 4, Number((totalBits >> 32n) & 0xffffffffn), true);
    let offset = 0;
    while (offset + 64 <= padded.length) {
      md5Transform(md5State.h, padded.subarray(offset, offset + 64));
      offset += 64;
    }
    const result = new Uint8Array(16);
    const rv = new DataView(result.buffer);
    for (let i = 0; i < 4; i++) rv.setUint32(i * 4, md5State.h[i]!, true);
    return result;
  }
  function md5Transform(state: Uint32Array, block: Uint8Array): void {
    const M = new Array<number>(16);
    const bv = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) M[i] = bv.getUint32(i * 4, true);
    let [a, b, c, d] = [state[0]!, state[1]!, state[2]!, state[3]!];
    const S = [
      7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
      5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
      4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
      6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
    ];
    const K = new Array<number>(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16)      { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d;           g = (3 * i + 5) % 16; }
      else              { f = c ^ (b | ~d);        g = (7 * i) % 16; }
      f = (f + a + K[i]! + M[g]!) >>> 0;
      const s = S[i]!;
      const tmp = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
      a = d; d = c; c = b; b = tmp;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
  }

  // Pure-JS SHA1 implementation (FIPS 180-1)
  const sha1State = { buf: new Uint8Array(0), h: new Uint32Array(5), len: 0 };
  function sha1Init() {
    sha1State.h[0] = 0x67452301; sha1State.h[1] = 0xefcdab89;
    sha1State.h[2] = 0x98badcfe; sha1State.h[3] = 0x10325476;
    sha1State.h[4] = 0xc3d2e1f0;
    sha1State.buf = new Uint8Array(0); sha1State.len = 0;
  }
  function sha1Update(data: Uint8Array) {
    const combined = new Uint8Array(sha1State.buf.length + data.length);
    combined.set(sha1State.buf); combined.set(data, sha1State.buf.length);
    sha1State.len += data.length;
    let offset = 0;
    while (offset + 64 <= combined.length) {
      sha1Transform(sha1State.h, combined.subarray(offset, offset + 64));
      offset += 64;
    }
    sha1State.buf = combined.slice(offset);
  }
  function sha1Finish(): Uint8Array {
    const totalBits = BigInt(sha1State.len) * 8n;
    const padLen = (55 - sha1State.buf.length % 64 + 64) % 64 + 1;
    const padded = new Uint8Array(sha1State.buf.length + padLen + 8);
    padded.set(sha1State.buf);
    padded[sha1State.buf.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Number((totalBits >> 32n) & 0xffffffffn), false);
    view.setUint32(padded.length - 4, Number(totalBits & 0xffffffffn), false);
    let offset = 0;
    while (offset + 64 <= padded.length) {
      sha1Transform(sha1State.h, padded.subarray(offset, offset + 64));
      offset += 64;
    }
    const result = new Uint8Array(20);
    const rv = new DataView(result.buffer);
    for (let i = 0; i < 5; i++) rv.setUint32(i * 4, sha1State.h[i]!, false);
    return result;
  }
  function sha1Transform(state: Uint32Array, block: Uint8Array): void {
    const W = new Array<number>(80);
    const bv = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) W[i] = bv.getUint32(i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = W[i-3]! ^ W[i-8]! ^ W[i-14]! ^ W[i-16]!;
      W[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [state[0]!, state[1]!, state[2]!, state[3]!, state[4]!];
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8f1bbcdc; }
      else              { f = b ^ c ^ d;                     k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + W[i]!) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
  }

  function writeDigestToMemory(bus: import("../memory/memory-bus.js").MemoryBus, addr: number, digest: Uint8Array) {
    for (let i = 0; i < digest.length; i++) bus.writeU8(addr + i, digest[i]!);
  }

  // sceKernelUtilsMd5BlockInit(ctx)
  kernel.register(KERNEL.sceKernelUtilsMd5BlockInit, (regs) => {
    md5Init();
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsMd5BlockUpdate(ctx, data, size)
  kernel.register(KERNEL.sceKernelUtilsMd5BlockUpdate, (regs, bus) => {
    const dataAddr = regs.getGpr(5) >>> 0;
    const size = regs.getGpr(6) | 0;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = bus.readU8(dataAddr + i);
    md5Update(data);
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsMd5BlockResult(ctx, digest)
  kernel.register(KERNEL.sceKernelUtilsMd5BlockResult, (regs, bus) => {
    const digestAddr = regs.getGpr(5) >>> 0;
    const digest = md5Finish();
    writeDigestToMemory(bus, digestAddr, digest);
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsMd5Digest(data, size, digest)
  kernel.register(KERNEL.sceKernelUtilsMd5Digest, (regs, bus) => {
    const dataAddr = regs.getGpr(4) >>> 0;
    const size = regs.getGpr(5) | 0;
    const digestAddr = regs.getGpr(6) >>> 0;
    md5Init();
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = bus.readU8(dataAddr + i);
    md5Update(data);
    const digest = md5Finish();
    writeDigestToMemory(bus, digestAddr, digest);
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsSha1BlockInit(ctx)
  kernel.register(KERNEL.sceKernelUtilsSha1BlockInit, (regs) => {
    sha1Init();
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsSha1BlockUpdate(ctx, data, size)
  kernel.register(KERNEL.sceKernelUtilsSha1BlockUpdate, (regs, bus) => {
    const dataAddr = regs.getGpr(5) >>> 0;
    const size = regs.getGpr(6) | 0;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = bus.readU8(dataAddr + i);
    sha1Update(data);
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsSha1BlockResult(ctx, digest)
  kernel.register(KERNEL.sceKernelUtilsSha1BlockResult, (regs, bus) => {
    const digestAddr = regs.getGpr(5) >>> 0;
    const digest = sha1Finish();
    writeDigestToMemory(bus, digestAddr, digest);
    regs.setGpr(2, 0);
  });

  // sceKernelUtilsSha1Digest(data, size, digest)
  kernel.register(KERNEL.sceKernelUtilsSha1Digest, (regs, bus) => {
    const dataAddr = regs.getGpr(4) >>> 0;
    const size = regs.getGpr(5) | 0;
    const digestAddr = regs.getGpr(6) >>> 0;
    sha1Init();
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = bus.readU8(dataAddr + i);
    sha1Update(data);
    const digest = sha1Finish();
    writeDigestToMemory(bus, digestAddr, digest);
    regs.setGpr(2, 0);
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
  kernel.stub(KERNEL._sceKernelReturnFromTimerHandler);
  kernel.stub(KERNEL.memcmp);
  kernel.stub(KERNEL.memcpy);
  kernel.stub(KERNEL.memmove);
  kernel.stub(KERNEL.memset);
  kernel.stub(KERNEL.sceKernelAllocateFplCB, 1);
  kernel.stub(KERNEL.sceKernelCancelEventFlag);
  kernel.stub(KERNEL.sceKernelCancelFpl);
  kernel.stub(KERNEL.sceKernelCancelMsgPipe);
  kernel.stub(KERNEL.sceKernelCancelMutex);
  kernel.stub(KERNEL.sceKernelCancelReceiveMbx);
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
  kernel.stub(KERNEL.sceKernelGetThreadmanIdType);
  kernel.stub(KERNEL.sceKernelGetTlsAddr, 1);
  kernel.stub(KERNEL.sceKernelGetVTimerBaseWide);
  kernel.stub(KERNEL.sceKernelGetVTimerTimeWide);
  kernel.stub(KERNEL.sceKernelGzipDecompress);
  kernel.stub(KERNEL.sceKernelIsCpuIntrSuspended);
  kernel.stub(KERNEL.sceKernelIsSubInterruptOccurred);
  kernel.stub(KERNEL.sceKernelLoadExec, 1);
  kernel.stub(KERNEL.sceKernelLoadExecVSHMs2, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleBufferUsbWlan, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleDNAS, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleForLoadExecVSHDisc, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleMs, 1);
  kernel.stub(KERNEL.sceKernelLoadModuleNpDrm, 1);
  kernel.stub(KERNEL.sceKernelQueryModuleInfo);
  kernel.stub(KERNEL.sceKernelReferAlarmStatus);
  kernel.stub(KERNEL.sceKernelReferCallbackStatus);
  kernel.stub(KERNEL.sceKernelReferEventFlagStatus);
  kernel.stub(KERNEL.sceKernelReferFplStatus);
  kernel.stub(KERNEL.sceKernelReferGlobalProfiler);
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
  kernel.stub(KERNEL.sceKernelResumeSubIntr);
  kernel.stub(KERNEL.sceKernelSendMsgPipeCB);
  kernel.stub(KERNEL.sceKernelSetSysClockAlarm);
  kernel.stub(KERNEL.sceKernelSetVTimerTimeWide);
  kernel.stub(KERNEL.sceKernelStopModule);
  kernel.stub(KERNEL.sceKernelStopUnloadSelfModule, 1);
  kernel.stub(KERNEL.sceKernelSuspendSubIntr);
  kernel.stub(KERNEL.sceKernelUnloadModule);
  kernel.stub(KERNEL.sceKernelUnregisterSubIntrHandler);
  kernel.stub(KERNEL.sceKernelUtilsMt19937Init, 1);
  kernel.stub(KERNEL.sceKernelUtilsMt19937UInt);
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
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion401_402);
  kernel.stub(SYSMEM.sceKernelSetCompiledSdkVersion507);
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
