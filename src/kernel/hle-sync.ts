/**
 * HLE synchronization handlers for semaphores, mutexes, event flags,
 * FPL/VPL pools, message pipes, and memory management.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { ThreadState, WaitType } from "./hle-kernel.js";
import { SEMA, MUTEX, EVENT_FLAG, FPL, VPL, MSG_PIPE, SYSMEM } from "./nids.js";

const log = Logger.get("HLE-SYNC");

export function registerSyncHLE(kernel: HLEKernel): void {

  // ── VPL (variable-size partition list) ────────────────────────────────
  const vpls = new Map<number, { baseAddr: number; size: number; nextFree: number }>();

  // ── Semaphores ────────────────────────────────────────────────────────

  // sceKernelCreateSema(name, attr, initVal, maxVal, option) → id
  kernel.register(SEMA.sceKernelCreateSema, (regs, bus) => {
    const namePtr = regs.getGpr(4);
    const attr    = regs.getGpr(5);
    const initVal = regs.getGpr(6);
    const maxVal  = regs.getGpr(7);
    const sid = kernel.nextBlockId++;
    // Read name string
    let name = "";
    for (let i = 0; i < 31; i++) {
      const b = bus.readU8(namePtr + i);
      if (b === 0) break;
      name += String.fromCharCode(b);
    }
    kernel.semaphores.set(sid, { name, attr, initCount: initVal, count: initVal, maxCount: maxVal > 0 ? maxVal : 0x7fffffff });
    regs.setGpr(2, sid);
  });

  // sceKernelDeleteSema(semId)
  kernel.register(SEMA.sceKernelDeleteSema, (regs) => {
    kernel.semaphores.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // sceKernelSignalSema(semId, signal)
  kernel.register(SEMA.sceKernelSignalSema, (regs) => {
    const semId  = regs.getGpr(4);
    const signal = regs.getGpr(5);
    const sema = kernel.semaphores.get(semId);
    if (sema) {
      sema.count = Math.min(sema.count + signal, sema.maxCount);
      for (const t of kernel.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.SEMA && t.waitSemaId === semId) {
          if (sema.count >= t.waitSemaCount) {
            sema.count -= t.waitSemaCount;
            t.state = ThreadState.READY;
            t.waitType = WaitType.NONE;
            t.context.gpr[2] = 0;
          }
        }
      }
    }
    regs.setGpr(2, 0);
  });

  // sceKernelWaitSema / sceKernelWaitSemaCB
  const waitSema = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void => {
    const semId  = regs.getGpr(4);
    const signal = regs.getGpr(5);
    const sema = kernel.semaphores.get(semId);
    if (!sema) { regs.setGpr(2, 0); return; }

    if (sema.count >= signal) {
      sema.count -= signal;
      regs.setGpr(2, 0);
      return;
    }

    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.SEMA;
      t.waitSemaId = semId;
      t.waitSemaCount = signal;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      sema.count = 0;
      regs.setGpr(2, 0);
    }
  };
  kernel.register(SEMA.sceKernelWaitSema,   waitSema);
  kernel.register(SEMA.sceKernelWaitSemaCB, waitSema);

  // sceKernelPollSema(semId, signal) — non-blocking
  kernel.register(SEMA.sceKernelPollSema, (regs) => {
    const semId  = regs.getGpr(4);
    const signal = regs.getGpr(5);
    const sema = kernel.semaphores.get(semId);
    if (sema && sema.count >= signal) {
      sema.count -= signal;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800201cd >>> 0); // SCE_KERNEL_ERROR_SEMA_ZERO
    }
  });

  // sceKernelReferSemaStatus — fills NativeSemaphore struct (56 bytes)
  kernel.register(SEMA.sceKernelReferSemaStatus, (regs, bus) => {
    const semId = regs.getGpr(4);
    const ptr   = regs.getGpr(5);
    const sema  = kernel.semaphores.get(semId);
    if (sema && ptr !== 0) {
      bus.writeU32(ptr, 56);  // size
      // Write name at offset 4 (32 bytes)
      for (let i = 0; i < 32; i++) {
        bus.writeU8(ptr + 4 + i, i < sema.name.length ? sema.name.charCodeAt(i) : 0);
      }
      bus.writeU32(ptr + 36, sema.attr);        // attr
      bus.writeU32(ptr + 40, sema.initCount);   // initCount
      bus.writeU32(ptr + 44, sema.count);       // currentCount
      bus.writeU32(ptr + 48, sema.maxCount);    // maxCount
      // Count waiting threads
      let waitCount = 0;
      for (const t of kernel.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.SEMA && t.waitSemaId === semId) waitCount++;
      }
      bus.writeU32(ptr + 52, waitCount);        // numWaitThreads
    }
    regs.setGpr(2, sema ? 0 : 0x800201bc); // SCE_KERNEL_ERROR_UNKNOWN_SEMID
  });

  // ── Mutexes ───────────────────────────────────────────────────────────
  // PPSSPP sceKernelMutex.cpp
  interface MutexState { name: string; attr: number; lockLevel: number; lockThread: number; }
  const mutexes = new Map<number, MutexState>();
  const SCE_MUTEX_ERROR_NO_SUCH_MUTEX = 0x800201c3 >>> 0;
  const SCE_MUTEX_ERROR_NOT_LOCKED    = 0x800201c5 >>> 0;
  const SCE_MUTEX_ERROR_ALREADY_LOCKED = 0x800201c7 >>> 0;
  const SCE_MUTEX_ERROR_LOCK_OVERFLOW  = 0x800201c8 >>> 0;
  const SCE_MUTEX_ERROR_UNLOCK_UNDERFLOW = 0x800201c9 >>> 0;
  const PSP_MUTEX_ATTR_ALLOW_RECURSIVE = 0x200;

  // sceKernelCreateMutex(name, attr, initialCount, optionsPtr)
  kernel.register(MUTEX.sceKernelCreateMutex, (regs, bus) => {
    const namePtr = regs.getGpr(4);
    const attr = regs.getGpr(5);
    const initialCount = regs.getGpr(6) | 0;
    let name = "";
    for (let i = 0; i < 31; i++) { const b = bus.readU8(namePtr + i); if (b === 0) break; name += String.fromCharCode(b); }
    if (initialCount < 0) { regs.setGpr(2, 0x80020001 >>> 0); return; } // SCE_KERNEL_ERROR_ILLEGAL_COUNT
    if (!(attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE) && initialCount > 1) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    const mid = kernel.nextBlockId++;
    mutexes.set(mid, { name, attr, lockLevel: initialCount, lockThread: initialCount > 0 ? kernel.currentThreadId : -1 });
    regs.setGpr(2, mid);
  });

  // sceKernelDeleteMutex(id)
  kernel.register(MUTEX.sceKernelDeleteMutex, (regs) => {
    const id = regs.getGpr(4);
    if (!mutexes.has(id)) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    mutexes.delete(id);
    regs.setGpr(2, 0);
  });

  // sceKernelLockMutex(id, count, timeout)
  kernel.register(MUTEX.sceKernelLockMutex, (regs) => {
    const id = regs.getGpr(4);
    const count = regs.getGpr(5) | 0;
    const m = mutexes.get(id);
    if (!m) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    if (count <= 0) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    if (m.lockLevel === 0) {
      m.lockLevel = count;
      m.lockThread = kernel.currentThreadId;
      regs.setGpr(2, 0);
    } else if (m.lockThread === kernel.currentThreadId) {
      if (!(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) { regs.setGpr(2, SCE_MUTEX_ERROR_ALREADY_LOCKED); return; }
      if (m.lockLevel + count < 0) { regs.setGpr(2, SCE_MUTEX_ERROR_LOCK_OVERFLOW); return; }
      m.lockLevel += count;
      regs.setGpr(2, 0);
    } else {
      // Block thread until mutex is available
      const t = kernel.threads.get(kernel.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.MUTEX;
        t.waitMutexId = id;
        t.waitMutexCount = count;
        kernel.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!kernel.reschedule(regs)) kernel.idleBreak = true;
      }
    }
  });

  // sceKernelTryLockMutex(id, count)
  kernel.register(MUTEX.sceKernelTryLockMutex, (regs) => {
    const id = regs.getGpr(4);
    const count = regs.getGpr(5) | 0;
    const m = mutexes.get(id);
    if (!m) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    if (count <= 0) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    if (m.lockLevel === 0) {
      m.lockLevel = count;
      m.lockThread = kernel.currentThreadId;
      regs.setGpr(2, 0);
    } else if (m.lockThread === kernel.currentThreadId) {
      if (!(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) { regs.setGpr(2, SCE_MUTEX_ERROR_ALREADY_LOCKED); return; }
      m.lockLevel += count;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800201c4 >>> 0); // SCE_MUTEX_ERROR_TRYLOCK_FAILED
    }
  });

  // sceKernelUnlockMutex(id, count)
  kernel.register(MUTEX.sceKernelUnlockMutex, (regs) => {
    const id = regs.getGpr(4);
    const count = regs.getGpr(5) | 0;
    const m = mutexes.get(id);
    if (!m) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    if (count <= 0) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    if (m.lockLevel === 0 || m.lockThread !== kernel.currentThreadId) { regs.setGpr(2, SCE_MUTEX_ERROR_NOT_LOCKED); return; }
    if (m.lockLevel < count) { regs.setGpr(2, SCE_MUTEX_ERROR_UNLOCK_UNDERFLOW); return; }
    m.lockLevel -= count;
    if (m.lockLevel === 0) {
      m.lockThread = -1;
      // Wake highest-priority thread waiting for this mutex
      let best: ReturnType<typeof kernel.threads.get> = undefined;
      for (const t of kernel.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.MUTEX && t.waitMutexId === id) {
          if (!best || t.priority < best.priority) best = t;
        }
      }
      if (best) {
        m.lockLevel = best.waitMutexCount;
        m.lockThread = best.id;
        best.state = ThreadState.READY;
        best.waitType = WaitType.NONE;
        best.context.gpr[2] = 0;
      }
    }
    regs.setGpr(2, 0);
  });

  // ── Event Flags ───────────────────────────────────────────────────────

  interface EventFlag {
    pattern: number;     // current bit pattern (u32)
    attr: number;        // creation attributes
  }
  const eventFlags = new Map<number, EventFlag>();

  /** Check if event flag condition is met (AND/OR mode) */
  const evfCondMet = (pattern: number, bits: number, waitMode: number): boolean => {
    if (waitMode & 1) {
      // OR mode: any bit matches
      return (bits & pattern) !== 0;
    } else {
      // AND mode: all bits must match
      return (bits & pattern) === bits;
    }
  };

  /** Apply CLEAR semantics after a successful match */
  const evfApplyClear = (evf: EventFlag, bits: number, waitMode: number): void => {
    if (waitMode & 0x20) {
      // CLEAR matched bits only
      evf.pattern &= ~bits;
    } else if (waitMode & 0x10) {
      // CLEAR all bits
      evf.pattern = 0;
    }
  };

  // sceKernelCreateEventFlag(name, attr, initPattern, optPtr)
  kernel.register(EVENT_FLAG.sceKernelCreateEventFlag, (regs) => {
    const attr        = regs.getGpr(5);
    const initPattern = regs.getGpr(6);
    const eid = kernel.nextBlockId++;
    eventFlags.set(eid, { pattern: initPattern >>> 0, attr });
    log.debug(`sceKernelCreateEventFlag(attr=0x${attr.toString(16)}, pattern=0x${initPattern.toString(16)}) → id=${eid}`);
    regs.setGpr(2, eid);
  });

  // sceKernelPollEventFlag(id, bits, waitMode, outBitsPtr)
  kernel.register(EVENT_FLAG.sceKernelPollEventFlag, (regs, bus) => {
    const id         = regs.getGpr(4);
    const bits       = regs.getGpr(5);
    const waitMode   = regs.getGpr(6);
    const outBitsPtr = regs.getGpr(7);
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    if (outBitsPtr !== 0) bus.writeU32(outBitsPtr, evf.pattern);
    if (evfCondMet(evf.pattern, bits, waitMode)) {
      evfApplyClear(evf, bits, waitMode);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800201af >>> 0); // SCE_KERNEL_ERROR_EVF_COND
    }
  });

  // sceKernelSetEventFlag(id, bitsToSet)
  kernel.register(EVENT_FLAG.sceKernelSetEventFlag, (regs) => {
    const id        = regs.getGpr(4);
    const bitsToSet = regs.getGpr(5);
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    evf.pattern = (evf.pattern | bitsToSet) >>> 0;
    // Wake any threads waiting on this event flag
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.EVENT_FLAG && t.waitEvfId === id) {
        if (evfCondMet(evf.pattern, t.waitEvfBits, t.waitEvfMode)) {
          // Write outBits before clearing
          if (t.waitEvfOutPtr !== 0) kernel.bus.writeU32(t.waitEvfOutPtr, evf.pattern);
          evfApplyClear(evf, t.waitEvfBits, t.waitEvfMode);
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          t.context.gpr[2] = 0;
        }
      }
    }
    regs.setGpr(2, 0);
  });

  // sceKernelClearEventFlag(id, bitsToClear)
  kernel.register(EVENT_FLAG.sceKernelClearEventFlag, (regs) => {
    const id          = regs.getGpr(4);
    const bitsToClear = regs.getGpr(5);
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    evf.pattern = (evf.pattern & bitsToClear) >>> 0;
    regs.setGpr(2, 0);
  });

  // sceKernelWaitEventFlag / sceKernelWaitEventFlagCB
  const waitEventFlag = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0], bus: Parameters<Parameters<typeof kernel.register>[1]>[1], cb: boolean): void => {
    const id         = regs.getGpr(4);
    const bits       = regs.getGpr(5);
    const waitMode   = regs.getGpr(6);
    const outBitsPtr = regs.getGpr(7);
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    // Check if condition already met
    if (evfCondMet(evf.pattern, bits, waitMode)) {
      if (outBitsPtr !== 0) bus.writeU32(outBitsPtr, evf.pattern);
      evfApplyClear(evf, bits, waitMode);
      regs.setGpr(2, 0);
      return;
    }
    // Block the thread
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.EVENT_FLAG;
      t.waitEvfId = id;
      t.waitEvfBits = bits;
      t.waitEvfMode = waitMode;
      t.waitEvfOutPtr = outBitsPtr;
      if (cb) t.isProcessingCallbacks = true;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, 0);
    }
  };
  kernel.register(EVENT_FLAG.sceKernelWaitEventFlag, (regs, bus) => waitEventFlag(regs, bus, false));
  kernel.register(EVENT_FLAG.sceKernelWaitEventFlagCB, (regs, bus) => waitEventFlag(regs, bus, true));

  // sceKernelDeleteEventFlag(id)
  kernel.register(EVENT_FLAG.sceKernelDeleteEventFlag, (regs) => {
    const id = regs.getGpr(4);
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    // Wake all waiting threads with error
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.EVENT_FLAG && t.waitEvfId === id) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201a4 >>> 0; // SCE_KERNEL_ERROR_WAIT_DELETE
      }
    }
    eventFlags.delete(id);
    regs.setGpr(2, 0);
  });

  // ── FPL (fixed pool list) — PPSSPP sceKernelMemory.cpp ───────────────
  interface FplState { base: number; blockSize: number; numBlocks: number; freeBlocks: boolean[] }
  const fpls = new Map<number, FplState>();
  const SCE_KERNEL_ERROR_UNKNOWN_FPLID = 0x80020199 >>> 0;
  const SCE_KERNEL_ERROR_NO_MEMORY     = 0x80020190 >>> 0;

  function fplAlloc(fpl: FplState): number {
    for (let i = 0; i < fpl.numBlocks; i++) {
      if (fpl.freeBlocks[i]) {
        fpl.freeBlocks[i] = false;
        return i;
      }
    }
    return -1;
  }

  // sceKernelCreateFpl(name, part, attr, blockSize, numBlocks, option)
  kernel.register(FPL.sceKernelCreateFpl, (regs, bus) => {
    const blockSize = regs.getGpr(7);
    const sp = regs.getGpr(29);
    const rawNumBlocks = bus.readU32(sp + 16) | 0;
    const numBlocks = Math.max(1, Math.min(rawNumBlocks, 4096)); // clamp to sane range
    const fplId = kernel.nextBlockId++;
    const aligned = (blockSize + 3) & ~3; // 4-byte align (PPSSPP uses BlockAllocator)
    const totalSize = aligned * numBlocks;
    const addr = kernel.nextAllocAddr;
    kernel.nextAllocAddr = (addr + totalSize) >>> 0;
    fpls.set(fplId, { base: addr, blockSize: aligned, numBlocks, freeBlocks: new Array(numBlocks).fill(true) });
    kernel.memBlocks.set(fplId, { addr, size: totalSize, name: "FPL" });
    regs.setGpr(2, fplId);
  });

  // sceKernelDeleteFpl
  kernel.register(FPL.sceKernelDeleteFpl, (regs) => {
    const fplId = regs.getGpr(4);
    if (!fpls.has(fplId)) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_FPLID); return; }
    fpls.delete(fplId);
    kernel.memBlocks.delete(fplId);
    regs.setGpr(2, 0);
  });

  // sceKernelAllocateFpl(fplId, dataPtr, timeout)
  kernel.register(FPL.sceKernelAllocateFpl, (regs) => {
    const fplId   = regs.getGpr(4);
    const dataPtr = regs.getGpr(5);
    const fpl = fpls.get(fplId);
    if (!fpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_FPLID); return; }
    const blockNum = fplAlloc(fpl);
    if (blockNum >= 0 && dataPtr !== 0) {
      kernel.bus.writeU32(dataPtr, fpl.base + fpl.blockSize * blockNum);
      regs.setGpr(2, 0);
    } else {
      // TODO: block thread until a block is freed
      regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY);
    }
  });

  // sceKernelTryAllocateFpl(fplId, dataPtr)
  kernel.register(FPL.sceKernelTryAllocateFpl, (regs) => {
    const fplId   = regs.getGpr(4);
    const dataPtr = regs.getGpr(5);
    const fpl = fpls.get(fplId);
    if (!fpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_FPLID); return; }
    const blockNum = fplAlloc(fpl);
    if (blockNum >= 0 && dataPtr !== 0) {
      kernel.bus.writeU32(dataPtr, fpl.base + fpl.blockSize * blockNum);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY);
    }
  });

  // sceKernelFreeFpl(fplId, blockPtr)
  kernel.register(FPL.sceKernelFreeFpl, (regs) => {
    const fplId    = regs.getGpr(4);
    const blockPtr = regs.getGpr(5);
    const fpl = fpls.get(fplId);
    if (!fpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_FPLID); return; }
    const offset = blockPtr - fpl.base;
    const blockNum = Math.floor(offset / fpl.blockSize);
    if (blockNum >= 0 && blockNum < fpl.numBlocks) {
      fpl.freeBlocks[blockNum] = true;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800200d8 >>> 0); // SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCK
    }
  });

  // ── VPL (variable pool list) ─────────────────────────────────────────

  // sceKernelCreateVpl(name, partition, attr, vplSize, option)
  kernel.register(VPL.sceKernelCreateVpl, (regs) => {
    const vplSize = regs.getGpr(7);
    const aligned = (vplSize + 0xFF) & ~0xFF;
    const baseAddr = kernel.nextAllocAddr;
    kernel.nextAllocAddr = (kernel.nextAllocAddr + aligned) >>> 0;
    const vplId = kernel.nextBlockId++;
    vpls.set(vplId, { baseAddr, size: aligned, nextFree: baseAddr });
    log.debug(`sceKernelCreateVpl(size=${vplSize}) → id=${vplId} base=0x${baseAddr.toString(16)}`);
    regs.setGpr(2, vplId);
  });

  // sceKernelDeleteVpl
  kernel.register(VPL.sceKernelDeleteVpl, (regs) => {
    vpls.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // sceKernelAllocateVpl(vplId, size, addrPtr, timeout)
  kernel.register(VPL.sceKernelAllocateVpl, (regs, bus) => {
    const vplId   = regs.getGpr(4);
    const size    = regs.getGpr(5);
    const addrPtr = regs.getGpr(6);
    const vpl = vpls.get(vplId);
    if (vpl && addrPtr !== 0) {
      const aligned = (size + 15) & ~15;
      const addr = vpl.nextFree;
      vpl.nextFree = (vpl.nextFree + aligned) >>> 0;
      bus.writeU32(addrPtr, addr);
      log.debug(`sceKernelAllocateVpl(id=${vplId}, size=${size}) → 0x${addr.toString(16)}`);
      regs.setGpr(2, 0);
    } else {
      log.warn(`sceKernelAllocateVpl: unknown vplId=${vplId}`);
      regs.setGpr(2, -1 >>> 0);
    }
  });

  // sceKernelTryAllocateVpl
  kernel.register(VPL.sceKernelTryAllocateVpl, (regs, bus) => {
    const vplId   = regs.getGpr(4);
    const size    = regs.getGpr(5);
    const addrPtr = regs.getGpr(6);
    const vpl = vpls.get(vplId);
    if (vpl && addrPtr !== 0) {
      const aligned = (size + 15) & ~15;
      const addr = vpl.nextFree;
      vpl.nextFree = (vpl.nextFree + aligned) >>> 0;
      bus.writeU32(addrPtr, addr);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, -1 >>> 0);
    }
  });

  // ── Message Pipes ─────────────────────────────────────────────────────
  kernel.register(MSG_PIPE.sceKernelCreateMsgPipe, (regs) => { regs.setGpr(2, kernel.nextBlockId++); });

  // ── SysMemUserForUser (partition memory management) ───────────────────

  // sceKernelAllocPartitionMemory
  kernel.register(SYSMEM.sceKernelAllocPartitionMemory, (regs, bus) => {
    const partition = regs.getGpr(4);
    const namePtr   = regs.getGpr(5);
    const allocType = regs.getGpr(6);
    const size      = regs.getGpr(7);
    const addrHint  = regs.getGpr(8);

    let name = "";
    if (namePtr !== 0) {
      for (let i = 0; i < 32; i++) {
        const b = bus.readU8(namePtr + i);
        if (b === 0) break;
        name += String.fromCharCode(b);
      }
    }

    let addr: number;
    if (allocType === 2) {
      addr = addrHint & ~0xFF;
    } else if (allocType === 1 || allocType === 4) {
      const sizeAligned = (size + 0xFF) & ~0xFF;
      addr = (kernel.nextHighAddr - sizeAligned) & ~0xFF;
      if (addr < kernel.nextAllocAddr + 0x4000) {
        log.error(`sceKernelAllocPartitionMemory: high heap exhausted`);
        regs.setGpr(2, -1);
        return;
      }
      kernel.nextHighAddr = addr;
    } else {
      addr = (kernel.nextAllocAddr + 0xFF) & ~0xFF;
      const end = addr + size;
      if (end > kernel.nextHighAddr - 0x4000) {
        log.error(`sceKernelAllocPartitionMemory: low heap exhausted`);
        regs.setGpr(2, -1);
        return;
      }
      kernel.nextAllocAddr = end >>> 0;
    }

    const blockId = kernel.nextBlockId++;
    kernel.memBlocks.set(blockId, { addr, size, name });
    log.debug(`sceKernelAllocPartitionMemory(part=${partition}, "${name}", type=${allocType}, size=0x${size.toString(16)}) → uid=${blockId} addr=0x${addr.toString(16)}`);
    regs.setGpr(2, blockId);
  });

  // sceKernelGetBlockHeadAddr
  kernel.register(SYSMEM.sceKernelGetBlockHeadAddr, (regs) => {
    const blockId = regs.getGpr(4);
    const block = kernel.memBlocks.get(blockId);
    const addr = block ? block.addr : 0;
    log.debug(`sceKernelGetBlockHeadAddr(${blockId}) → 0x${addr.toString(16)}`);
    regs.setGpr(2, addr);
  });

  // sceKernelFreePartitionMemory
  kernel.register(SYSMEM.sceKernelFreePartitionMemory, (regs) => {
    kernel.memBlocks.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // sceKernelMaxFreeMemSize — largest contiguous free block
  kernel.register(SYSMEM.sceKernelMaxFreeMemSize, (regs) => {
    // Simple: gap between low alloc and high alloc
    const free = Math.max(0, kernel.nextHighAddr - kernel.nextAllocAddr);
    regs.setGpr(2, free >>> 0);
  });

  // sceKernelTotalFreeMemSize — total free memory
  kernel.register(SYSMEM.sceKernelTotalFreeMemSize, (regs) => {
    const free = Math.max(0, kernel.nextHighAddr - kernel.nextAllocAddr);
    regs.setGpr(2, free >>> 0);
  });

  // sceKernelMemset(addr, fillByte, n)
  kernel.register(SYSMEM.sceKernelMemset, (regs, bus) => {
    const addr = regs.getGpr(4);
    const fill = regs.getGpr(5) & 0xFF;
    const n    = regs.getGpr(6);
    for (let i = 0; i < n; i++) bus.writeU8(addr + i, fill);
    regs.setGpr(2, addr);
  });

  // ── SysMem user-level block allocation ──────────────────────────────

  // AllocMemoryBlock(name, type, size, param)
  kernel.register(SYSMEM.AllocMemoryBlock, (regs) => {
    const size = regs.getGpr(6);
    const aligned = (size + 0xFF) & ~0xFF;
    const addr = kernel.nextAllocAddr;
    kernel.nextAllocAddr = (kernel.nextAllocAddr + aligned) >>> 0;
    const uid = kernel.nextBlockId++;
    kernel.memBlocks.set(uid, { addr, size: aligned, name: "UserBlock" });
    log.debug(`AllocMemoryBlock(size=${size}) → uid=${uid} addr=0x${addr.toString(16)}`);
    regs.setGpr(2, uid);
  });

  // GetMemoryBlockPtr(uid, addr_out)
  kernel.register(SYSMEM.GetMemoryBlockPtr, (regs) => {
    const uid     = regs.getGpr(4);
    const addrOut = regs.getGpr(5);
    const block   = kernel.memBlocks.get(uid);
    if (block && addrOut !== 0) {
      kernel.bus.writeU32(addrOut, block.addr);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800200d6); // SCE_KERNEL_ERROR_UNKNOWN_UID
    }
  });

  // FreeMemoryBlock(uid)
  kernel.register(SYSMEM.FreeMemoryBlock, (regs) => {
    kernel.memBlocks.delete(regs.getGpr(4));
    regs.setGpr(2, 0);
  });

  // ── SDK / compiler version stubs ─────────────────────────────────────

  // sceKernelSetCompiledSdkVersion603_605
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion603_605, (regs) => {
    log.debug(`sceKernelSetCompiledSdkVersion(0x${regs.getGpr(4).toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompilerVersion
  kernel.register(SYSMEM.sceKernelSetCompilerVersion, (regs) => {
    log.debug(`sceKernelSetCompilerVersion(0x${regs.getGpr(4).toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelDevkitVersion
  kernel.register(SYSMEM.sceKernelDevkitVersion, (regs) => {
    regs.setGpr(2, 0x06060010); // 6.60
  });

  // sceKernelSetCompiledSdkVersion (generic)
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion, (regs) => {
    log.debug(`sceKernelSetCompiledSdkVersion(0x${regs.getGpr(4).toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion350_360
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion350_360, (regs) => {
    log.debug(`sceKernelSetCompiledSdkVersion350_360(0x${regs.getGpr(4).toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion370
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion370, (regs) => {
    log.debug(`sceKernelSetCompiledSdkVersion370(0x${regs.getGpr(4).toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion380_390
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion380_390, (regs) => {
    regs.setGpr(2, 0);
  });

  // sceKernelGetCompiledSdkVersion
  kernel.register(SYSMEM.sceKernelGetCompiledSdkVersion, (regs) => {
    regs.setGpr(2, 0x06060010);
  });

  // sceKernelDcacheWritebackRange — PPSSPP sceKernel.cpp: validate size >= 0
  kernel.register(SYSMEM.sceKernelDcacheWritebackRange, (regs) => {
    regs.setGpr(2, (regs.getGpr(5) | 0) < 0 ? 0x800200d5 : 0);
  });
  kernel.register(SYSMEM.sceKernelDcacheWritebackInvalidateRange, (regs) => {
    regs.setGpr(2, (regs.getGpr(5) | 0) < 0 ? 0x800200d5 : 0);
  });

  // ── Stubs (no-op / unimplemented) ───────────────────────────────────

  kernel.stub(MUTEX.sceKernelCreateLwMutex);
  kernel.stub(MUTEX.sceKernelReferLwMutexStatusByID);
  kernel.stub(MUTEX.sceKernelDeleteLwMutex);


  kernel.stub(VPL.sceKernelFreeVpl);

  kernel.stub(MSG_PIPE.sceKernelDeleteMsgPipe);
  kernel.stub(MSG_PIPE.sceKernelSendMsgPipe);
  kernel.stub(MSG_PIPE.sceKernelReceiveMsgPipe);
  kernel.stub(MSG_PIPE.sceKernelTrySendMsgPipe);
  kernel.stub(MSG_PIPE.sceKernelTryReceiveMsgPipe);

  kernel.register(SYSMEM.sceKernelDcacheWritebackAll, (regs) => { regs.setGpr(2, 0); });
  kernel.register(SYSMEM.sceKernelDcacheWritebackInvalidateAll, (regs) => { regs.setGpr(2, 0); });
  kernel.register(SYSMEM.sceKernelIcacheInvalidateAll, (regs) => { regs.setGpr(2, 0); });
  kernel.stub(SYSMEM.sceKernelIcacheInvalidateRange);

  log.info("Sync/Mem HLE handlers registered");
}
