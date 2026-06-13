/**
 * HLE synchronization handlers for semaphores, mutexes, event flags,
 * FPL/VPL pools, message pipes, and memory management.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import { ThreadState, WaitType } from "./hle-kernel.js";
import { SEMA, MUTEX, EVENT_FLAG, FPL, VPL, MSG_PIPE, SYSMEM, KERNEL } from "./nids.js";

const log = Logger.get("HLE-SYNC");

export function registerSyncHLE(kernel: HLEKernel): void {

  // ── VPL (variable-size partition list) ────────────────────────────────
  // PPSSPP-compatible block allocator — allocates from end (top) of pool.
  // Each block is measured in 8-byte units. A "block header" is 1 unit (8 bytes):
  //   - u32 next pointer (points to next FREE block, or sentinel if allocated)
  //   - u32 sizeInBlocks (including the header block itself)
  // Free blocks form a circular linked list. The last block (sentinel, size=0)
  // links to the first free block. Allocations split from the END of free blocks.

  interface VplBlock {
    offset: number;       // offset from memBlockPtr in bytes
    sizeInBlocks: number; // size in 8-byte blocks (includes 1-block header)
    free: boolean;        // true if this block is free
  }

  interface VplState {
    memBlockPtr: number;  // base of entire VPL memory (including 0x20 header)
    vplSize: number;      // total size passed to Init (aligned)
    poolAddr: number;     // memBlockPtr + 0x20 (start of usable pool)
    poolSize: number;     // vplSize - 0x20
    // Block list in address order (offset from memBlockPtr).
    // firstBlockOffset = 0x18, lastBlockOffset = vplSize - 8
    blocks: VplBlock[];
    firstBlockOffset: number; // 0x18
    lastBlockOffset: number;  // vplSize - 8
  }

  const vpls = new Map<number, VplState>();
  const SCE_KERNEL_ERROR_NO_MEMORY     = 0x80020190 >>> 0;
  const SCE_KERNEL_ERROR_UNKNOWN_VPLID = 0x8002019b >>> 0;
  const SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCK_VPL = 0x800201b6 >>> 0;
  const SCE_KERNEL_ERROR_ILLEGAL_MEMSIZE_VPL = 0x800201b7 >>> 0;

  /**
   * Try to allocate `size` bytes from VPL. Returns the user pointer (past header)
   * or -1 if no block is large enough. Matches PPSSPP SceKernelVplHeader::Allocate.
   */
  function vplAlloc(vpl: VplState, size: number): number {
    const allocBlocks = Math.floor((size + 7) / 8) + 1; // +1 for header
    // Search free blocks for one large enough (first fit, matching PPSSPP circular scan)
    for (let i = 0; i < vpl.blocks.length; i++) {
      const b = vpl.blocks[i]!;
      if (!b.free) continue;
      if (b.sizeInBlocks < allocBlocks) continue;

      if (b.sizeInBlocks > allocBlocks) {
        // Split: shrink free block from front, allocate from end (PPSSPP SplitBlock)
        const newFreeSize = b.sizeInBlocks - allocBlocks;
        b.sizeInBlocks = newFreeSize;
        // Insert new allocated block after the shrunk free block
        const newBlock: VplBlock = {
          offset: b.offset + newFreeSize * 8,
          sizeInBlocks: allocBlocks,
          free: false,
        };
        vpl.blocks.splice(i + 1, 0, newBlock);
        return vpl.memBlockPtr + newBlock.offset + 8; // +8 skips header
      } else {
        // Exact fit
        b.free = false;
        return vpl.memBlockPtr + b.offset + 8;
      }
    }
    return -1;
  }

  /**
   * Free a user pointer back to the VPL. Merges adjacent free blocks.
   * Returns true on success.
   */
  function vplFree(vpl: VplState, ptr: number): boolean {
    const blockOffset = (ptr - 8) - vpl.memBlockPtr; // header is 8 bytes before user ptr
    // Find the block
    for (let i = 0; i < vpl.blocks.length; i++) {
      const b = vpl.blocks[i]!;
      if (b.offset === blockOffset && !b.free) {
        b.free = true;
        // Merge with next free block
        if (i + 1 < vpl.blocks.length && vpl.blocks[i + 1]!.free) {
          b.sizeInBlocks += vpl.blocks[i + 1]!.sizeInBlocks;
          vpl.blocks.splice(i + 1, 1);
        }
        // Merge with previous free block
        if (i > 0 && vpl.blocks[i - 1]!.free) {
          vpl.blocks[i - 1]!.sizeInBlocks += b.sizeInBlocks;
          vpl.blocks.splice(i, 1);
        }
        return true;
      }
    }
    return false;
  }

  /** Try to wake threads waiting on a VPL after a free operation. */
  function vplWakeWaiters(vpl: VplState, vplId: number, regs: Parameters<Parameters<typeof kernel.register>[1]>[0]): void {
    let woke = false;
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.VPL && t.waitVplId === vplId) {
        const addr = vplAlloc(vpl, t.waitVplSize);
        if (addr !== -1 && t.waitVplAddrPtr !== 0) {
          kernel.bus.writeU32(t.waitVplAddrPtr, addr);
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          t.context.gpr[2] = 0;
          woke = true;
          break; // One at a time, like FPL
        }
      }
    }
    if (woke) kernel.reschedule(regs);
  }

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
  // PPSSPP sceKernelSemaphore.cpp:236-249
  kernel.register(SEMA.sceKernelDeleteSema, (regs) => {
    const semId = regs.getGpr(4);
    const sema = kernel.semaphores.get(semId);
    if (!sema) {
      regs.setGpr(2, 0x80020199 >>> 0); // SCE_KERNEL_ERROR_UNKNOWN_SEMID
      return;
    }
    // Wake all threads waiting on this sema with WAIT_DELETE error
    let wokeThreads = false;
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.SEMA && t.waitSemaId === semId) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201b5 >>> 0; // SCE_KERNEL_ERROR_WAIT_DELETE
        wokeThreads = true;
      }
    }
    kernel.semaphores.delete(semId);
    regs.setGpr(2, 0);
    if (wokeThreads) kernel.reschedule(regs);
  });

  // sceKernelCancelSema(semId, setCount, numWaitThreadsPtr)
  // PPSSPP sceKernelSemaphore.cpp:251-270
  kernel.register(KERNEL.sceKernelCancelSema, (regs, bus) => {
    const semId = regs.getGpr(4);
    const setCount = regs.getGpr(5) | 0; // signed
    const numWaitPtr = regs.getGpr(6);
    const sema = kernel.semaphores.get(semId);
    if (!sema) {
      regs.setGpr(2, 0x80020199 >>> 0); // SCE_KERNEL_ERROR_UNKNOWN_SEMID
      return;
    }

    // Count and wake all waiting threads with WAIT_CANCEL error
    let waitCount = 0;
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.SEMA && t.waitSemaId === semId) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201a9 >>> 0; // SCE_KERNEL_ERROR_WAIT_CANCEL
        waitCount++;
      }
    }

    // Write number of waiting threads to output pointer
    if (numWaitPtr !== 0) {
      bus.writeU32(numWaitPtr, waitCount);
    }

    // Reset sema count: if setCount < 0, reset to initCount; otherwise set to setCount
    sema.count = setCount < 0 ? sema.initCount : setCount;

    regs.setGpr(2, 0);
    // Don't reschedule here — the woken threads will be picked up naturally
    // by the normal scheduler. Calling reschedule inside an interrupt/alarm
    // handler context would corrupt thread state.
  });

  // sceKernelSignalSema(semId, signal)
  // PPSSPP sceKernelSemaphore.cpp:273
  kernel.register(SEMA.sceKernelSignalSema, (regs) => {
    const semId  = regs.getGpr(4);
    const signal = regs.getGpr(5);
    const sema = kernel.semaphores.get(semId);
    if (!sema) { regs.setGpr(2, 0x80020199 >>> 0); return; }
    sema.count = Math.min(sema.count + signal, sema.maxCount);
    let wokeThreads = false;
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.SEMA && t.waitSemaId === semId) {
        if (sema.count >= t.waitSemaCount) {
          sema.count -= t.waitSemaCount;
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          t.context.gpr[2] = 0;
          wokeThreads = true;
        }
      }
    }
    regs.setGpr(2, 0);
    if (wokeThreads) kernel.reschedule(regs);
  });

  // sceKernelWaitSema / sceKernelWaitSemaCB
  const waitSema = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0], bus: Parameters<Parameters<typeof kernel.register>[1]>[1]): void => {
    const semId  = regs.getGpr(4);
    const signal = regs.getGpr(5);
    const timeoutPtr = regs.getGpr(6);
    const sema = kernel.semaphores.get(semId);
    if (!sema) { regs.setGpr(2, 0); return; }

    if (sema.count >= signal) {
      sema.count -= signal;
      regs.setGpr(2, 0);
      return;
    }

    // Real PSP: waiting inside an interrupt/GE-callback context is illegal.
    // Blocking here would save mid-callback CPU state into the thread context
    // (the GE trampoline return address is on the stack) and corrupt execution
    // when the thread later wakes (Burnout Legends does this every frame).
    if (kernel.inInterrupt) {
      regs.setGpr(2, 0x800201a7); // SCE_KERNEL_ERROR_CAN_NOT_WAIT
      return;
    }

    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.SEMA;
      t.waitSemaId = semId;
      t.waitSemaCount = signal;
      t.isProcessingCallbacks = false; // per-wait; the CB wrapper re-enables
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;

      // Schedule timeout if a timeout pointer is provided
      if (timeoutPtr !== 0 && kernel.coreTiming && kernel.wakeThreadEventId >= 0) {
        const usec = bus.readU32(timeoutPtr);
        if (usec > 0) {
          const cycles = kernel.coreTiming.usToCycles(usec);
          kernel.coreTiming.scheduleEvent(cycles, kernel.wakeThreadEventId, kernel.currentThreadId);
        }
      }

      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      sema.count = 0;
      regs.setGpr(2, 0);
    }
  };
  kernel.register(SEMA.sceKernelWaitSema,   waitSema);
  // CB variant: this wait may run callbacks (PPSSPP processCallbacks=true)
  kernel.register(SEMA.sceKernelWaitSemaCB, (regs, bus) => {
    const t = kernel.threads.get(kernel.currentThreadId);
    waitSema(regs, bus);
    if (t && t.state === ThreadState.WAITING) t.isProcessingCallbacks = true;
  });

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
    regs.setGpr(2, sema ? 0 : 0x80020199 >>> 0); // SCE_KERNEL_ERROR_UNKNOWN_SEMID
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
    if (count > 1 && !(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) {
      regs.setGpr(2, 0x800201bd >>> 0); return; // SCE_KERNEL_ERROR_ILLEGAL_COUNT
    }
    if (m.lockLevel === 0) {
      m.lockLevel = count;
      m.lockThread = kernel.currentThreadId;
      regs.setGpr(2, 0);
    } else if (m.lockThread === kernel.currentThreadId) {
      if (!(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) { regs.setGpr(2, SCE_MUTEX_ERROR_LOCK_OVERFLOW); return; }
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
        t.isProcessingCallbacks = false; // plain wait never runs callbacks
        kernel.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!kernel.reschedule(regs)) kernel.idleBreak = true;
      }
    }
  });

  // sceKernelLockMutexCB — same as LockMutex but processes callbacks
  kernel.register(KERNEL.sceKernelLockMutexCB, (regs) => {
    const id = regs.getGpr(4);
    const count = regs.getGpr(5) | 0;
    const m = mutexes.get(id);
    if (!m) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    if (count <= 0) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    if (count > 1 && !(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) {
      regs.setGpr(2, 0x800201bd >>> 0); return;
    }
    if (m.lockLevel === 0) {
      m.lockLevel = count;
      m.lockThread = kernel.currentThreadId;
      regs.setGpr(2, 0);
    } else if (m.lockThread === kernel.currentThreadId) {
      if (!(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) { regs.setGpr(2, SCE_MUTEX_ERROR_LOCK_OVERFLOW); return; }
      if (m.lockLevel + count < 0) { regs.setGpr(2, SCE_MUTEX_ERROR_LOCK_OVERFLOW); return; }
      m.lockLevel += count;
      regs.setGpr(2, 0);
    } else {
      const t = kernel.threads.get(kernel.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.MUTEX;
        t.waitMutexId = id;
        t.waitMutexCount = count;
        t.isProcessingCallbacks = true;
        kernel.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!kernel.reschedule(regs)) kernel.idleBreak = true;
        return; // already dispatched via reschedule
      }
    }
    // CB variant: process callbacks after successful (non-blocking) lock
    kernel.processThreadCallbacks(regs, true);
  });

  // sceKernelTryLockMutex(id, count)
  kernel.register(MUTEX.sceKernelTryLockMutex, (regs) => {
    const id = regs.getGpr(4);
    const count = regs.getGpr(5) | 0;
    const m = mutexes.get(id);
    if (!m) { regs.setGpr(2, SCE_MUTEX_ERROR_NO_SUCH_MUTEX); return; }
    if (count <= 0) { regs.setGpr(2, 0x80020001 >>> 0); return; }
    if (count > 1 && !(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) {
      regs.setGpr(2, 0x800201bd >>> 0); return; // SCE_KERNEL_ERROR_ILLEGAL_COUNT
    }
    if (m.lockLevel === 0) {
      m.lockLevel = count;
      m.lockThread = kernel.currentThreadId;
      regs.setGpr(2, 0);
    } else if (m.lockThread === kernel.currentThreadId) {
      if (!(m.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) { regs.setGpr(2, SCE_MUTEX_ERROR_LOCK_OVERFLOW); return; }
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

  // ── Lightweight Mutexes ──────────────────────────────────────────────
  // PPSSPP sceKernelMutex.cpp — LwMutex stores lock state in user-space
  // memory (workarea). Kernel only tracks waiting threads.
  //
  // NativeLwMutexWorkarea layout (32 bytes):
  //   0x00: s32 lockLevel       — recursion count
  //   0x04: s32 lockThread      — thread ID holding lock (0 = unlocked)
  //   0x08: u32 attr            — creation attributes
  //   0x0C: s32 numWaitThreads  — not actively maintained
  //   0x10: s32 uid             — kernel object ID
  //   0x14: s32[3] pad

  interface LwMutexState {
    name: string;
    attr: number;
    uid: number;
    workareaPtr: number;
    initialCount: number;
    waitingThreads: number[];  // thread IDs
  }
  const lwMutexes = new Map<number, LwMutexState>();

  // Error codes — PPSSPP sceKernelMutex.cpp
  const SCE_KERNEL_ERROR_ILLEGAL_ATTR     = 0x80020010 >>> 0;
  const SCE_KERNEL_ERROR_ILLEGAL_COUNT    = 0x80020011 >>> 0;
  const SCE_KERNEL_ERROR_ILLEGAL_ADDR     = 0x80020006 >>> 0;
  const SCE_KERNEL_ERROR_ACCESS_ERROR     = 0x8002007f >>> 0;
  const SCE_KERNEL_ERROR_WAIT_DELETE      = 0x800201a8 >>> 0;
  const SCE_MUTEX_ERROR_TRYLOCK_FAILED    = 0x800201c4 >>> 0;
  const SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX = 0x800201ca >>> 0;
  const SCE_LWMUTEX_ERROR_TRYLOCK_FAILED  = 0x800201cb >>> 0;
  const SCE_LWMUTEX_ERROR_NOT_LOCKED      = 0x800201cc >>> 0;
  const SCE_LWMUTEX_ERROR_LOCK_OVERFLOW   = 0x800201cd >>> 0;
  const SCE_LWMUTEX_ERROR_UNLOCK_UNDERFLOW = 0x800201ce >>> 0;
  const SCE_LWMUTEX_ERROR_ALREADY_LOCKED  = 0x800201cf >>> 0;
  const PSP_MUTEX_ATTR_PRIORITY           = 0x100;

  /** Read workarea fields from PSP memory */
  function lwReadWorkarea(bus: import("../memory/memory-bus.js").MemoryBus, ptr: number) {
    return {
      lockLevel:      bus.readU32(ptr + 0x00) | 0,
      lockThread:     bus.readU32(ptr + 0x04) | 0,
      attr:           bus.readU32(ptr + 0x08),
      numWaitThreads: bus.readU32(ptr + 0x0C) | 0,
      uid:            bus.readU32(ptr + 0x10) | 0,
    };
  }

  /** Write workarea fields to PSP memory */
  function lwWriteWorkarea(bus: import("../memory/memory-bus.js").MemoryBus, ptr: number,
    lockLevel: number, lockThread: number, attr: number, numWaitThreads: number, uid: number) {
    bus.writeU32(ptr + 0x00, lockLevel);
    bus.writeU32(ptr + 0x04, lockThread);
    bus.writeU32(ptr + 0x08, attr);
    bus.writeU32(ptr + 0x0C, numWaitThreads);
    bus.writeU32(ptr + 0x10, uid);
  }

  /**
   * Try to acquire lock on workarea. Returns:
   *   { acquired: true }              — lock obtained
   *   { acquired: false, error: n }   — validation error
   *   { acquired: false, error: 0 }   — must block (contended)
   * Matches PPSSPP __KernelLockLwMutex (sceKernelMutex.cpp:766-815)
   */
  function lwTryLock(bus: import("../memory/memory-bus.js").MemoryBus, ptr: number, count: number):
    { acquired: true } | { acquired: false; error: number } {
    const wa = lwReadWorkarea(bus, ptr);
    // Validation
    if (count <= 0) return { acquired: false, error: SCE_KERNEL_ERROR_ILLEGAL_COUNT };
    if (count > 1 && !(wa.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE))
      return { acquired: false, error: SCE_KERNEL_ERROR_ILLEGAL_COUNT };
    if ((wa.lockLevel + count) < 0) return { acquired: false, error: SCE_LWMUTEX_ERROR_LOCK_OVERFLOW };
    if (wa.uid === -1) return { acquired: false, error: SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX };

    if (wa.lockLevel === 0) {
      // Unlocked — acquire
      bus.writeU32(ptr + 0x00, count);
      bus.writeU32(ptr + 0x04, kernel.currentThreadId);
      return { acquired: true };
    }
    if (wa.lockThread === kernel.currentThreadId) {
      // Already held by us
      if (!(wa.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE))
        return { acquired: false, error: SCE_LWMUTEX_ERROR_ALREADY_LOCKED };
      bus.writeU32(ptr + 0x00, wa.lockLevel + count);
      return { acquired: true };
    }
    // Contended — must block
    return { acquired: false, error: 0 };
  }

  /**
   * Wake the next waiter on a fully-unlocked lwmutex.
   * Returns true if a thread was woken (needs reschedule).
   * Matches PPSSPP __KernelUnlockLwMutex (sceKernelMutex.cpp:817-844)
   */
  function lwWakeNextWaiter(bus: import("../memory/memory-bus.js").MemoryBus, ptr: number, lwm: LwMutexState): boolean {
    if (lwm.waitingThreads.length === 0) {
      bus.writeU32(ptr + 0x04, 0); // lockThread = 0 (unlocked)
      return false;
    }
    // Pick thread: PRIORITY → highest priority; else FIFO
    let bestIdx = 0;
    if (lwm.attr & PSP_MUTEX_ATTR_PRIORITY) {
      let bestPri = Infinity;
      for (let i = 0; i < lwm.waitingThreads.length; i++) {
        const t = kernel.threads.get(lwm.waitingThreads[i]!);
        if (t && t.priority < bestPri) { bestPri = t.priority; bestIdx = i; }
      }
    }
    const tid = lwm.waitingThreads.splice(bestIdx, 1)[0]!;
    const t = kernel.threads.get(tid);
    if (!t || t.state !== ThreadState.WAITING || t.waitType !== WaitType.LWMUTEX) {
      // Stale — try next recursively
      return lwWakeNextWaiter(bus, ptr, lwm);
    }
    // Transfer lock to woken thread
    bus.writeU32(ptr + 0x00, t.waitMutexCount); // lockLevel = requested count
    bus.writeU32(ptr + 0x04, tid);               // lockThread = woken thread
    t.state = ThreadState.READY;
    t.waitType = WaitType.NONE;
    t.context.gpr[2] = 0; // return 0 to woken thread
    return true;
  }

  // sceKernelCreateLwMutex(workareaPtr, name, attr, initialCount, optionsPtr)
  // PPSSPP sceKernelMutex.cpp:668-711
  kernel.register(MUTEX.sceKernelCreateLwMutex, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    const namePtr     = regs.getGpr(5);
    const attr        = regs.getGpr(6);
    const initialCount = regs.getGpr(7) | 0;

    if (namePtr === 0) { regs.setGpr(2, 0x80020001 >>> 0); return; } // SCE_KERNEL_ERROR_ERROR
    if (attr >= 0x400) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_ATTR); return; }
    if (initialCount < 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_COUNT); return; }
    if (!(attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE) && initialCount > 1) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_COUNT); return;
    }

    let name = "";
    for (let i = 0; i < 31; i++) { const b = bus.readU8(namePtr + i); if (b === 0) break; name += String.fromCharCode(b); }

    const uid = kernel.nextBlockId++;
    const lwm: LwMutexState = { name, attr, uid, workareaPtr, initialCount, waitingThreads: [] };
    lwMutexes.set(uid, lwm);

    // Initialize workarea (memset 0 then set fields) — PPSSPP line 696-703
    for (let i = 0; i < 32; i += 4) bus.writeU32(workareaPtr + i, 0);
    lwWriteWorkarea(bus, workareaPtr,
      initialCount,
      initialCount === 0 ? 0 : kernel.currentThreadId,
      attr, 0, uid);

    log.debug(`sceKernelCreateLwMutex("${name}", attr=0x${attr.toString(16)}, init=${initialCount}) → uid=${uid}`);
    regs.setGpr(2, 0);
  });

  // sceKernelDeleteLwMutex(workareaPtr)
  // PPSSPP sceKernelMutex.cpp:738-764
  kernel.register(MUTEX.sceKernelDeleteLwMutex, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_ADDR); return; }
    const uid = bus.readU32(workareaPtr + 0x10) | 0;
    const lwm = lwMutexes.get(uid);
    if (!lwm) { regs.setGpr(2, SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX); return; }

    // Wake all waiters with SCE_KERNEL_ERROR_WAIT_DELETE
    let woke = false;
    for (const tid of lwm.waitingThreads) {
      const t = kernel.threads.get(tid);
      if (t && t.state === ThreadState.WAITING && t.waitType === WaitType.LWMUTEX) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = SCE_KERNEL_ERROR_WAIT_DELETE;
        woke = true;
      }
    }

    // Clear workarea — PPSSPP NativeLwMutexWorkarea::clear(): only lockLevel, lockThread, uid
    bus.writeU32(workareaPtr + 0x00, 0);  // lockLevel = 0
    bus.writeU32(workareaPtr + 0x04, -1); // lockThread = -1
    bus.writeU32(workareaPtr + 0x10, -1); // uid = -1
    lwMutexes.delete(uid);

    if (woke && !kernel.reschedule(regs)) kernel.idleBreak = true;
    regs.setGpr(2, 0);
  });

  // Shared lock handler for sceKernelLockLwMutex / _sceKernelLockLwMutex
  // PPSSPP sceKernelMutex.cpp:929-960
  const lwmLockHandler = (regs: import("../cpu/registers.js").AllegrexRegisters, bus: import("../memory/memory-bus.js").MemoryBus, cb: boolean) => {
    const workareaPtr = regs.getGpr(4);
    const count       = regs.getGpr(5) | 0;
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ACCESS_ERROR); return; }

    const result = lwTryLock(bus, workareaPtr, count);
    if (result.acquired) { regs.setGpr(2, 0); return; }
    if (result.error !== 0) { regs.setGpr(2, result.error); return; }

    // Must block — contended
    const uid = bus.readU32(workareaPtr + 0x10) | 0;
    const lwm = lwMutexes.get(uid);
    if (!lwm) { regs.setGpr(2, SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX); return; }

    const t = kernel.threads.get(kernel.currentThreadId);
    if (!t) return;
    // Avoid duplicate entries (PPSSPP line 951-952)
    if (!lwm.waitingThreads.includes(t.id)) lwm.waitingThreads.push(t.id);
    t.state = ThreadState.WAITING;
    t.waitType = WaitType.LWMUTEX;
    t.waitMutexId = uid;
    t.waitMutexCount = count;
    t.isProcessingCallbacks = cb; // per-wait (PPSSPP processCallbacks param)
    kernel.saveContext(t, regs);
    t.context.gpr[2] = 0;
    if (!kernel.reschedule(regs)) kernel.idleBreak = true;
  };

  kernel.register(KERNEL.sceKernelLockLwMutex, (regs, bus) => lwmLockHandler(regs, bus, false));
  kernel.register(KERNEL._sceKernelLockLwMutex, (regs, bus) => lwmLockHandler(regs, bus, false));
  kernel.register(KERNEL.sceKernelLockLwMutexCB, (regs, bus) => lwmLockHandler(regs, bus, true));
  kernel.register(KERNEL._sceKernelLockLwMutexCB, (regs, bus) => lwmLockHandler(regs, bus, true));

  // sceKernelTryLockLwMutex — pre-600: always returns TRYLOCK_FAILED on any error
  // PPSSPP sceKernelMutex.cpp:892-909
  kernel.register(KERNEL.sceKernelTryLockLwMutex, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    const count       = regs.getGpr(5) | 0;
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ACCESS_ERROR); return; }
    const result = lwTryLock(bus, workareaPtr, count);
    if (result.acquired) { regs.setGpr(2, 0); return; }
    regs.setGpr(2, SCE_MUTEX_ERROR_TRYLOCK_FAILED);
  });
  kernel.register(KERNEL._sceKernelTryLockLwMutex, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    const count       = regs.getGpr(5) | 0;
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ACCESS_ERROR); return; }
    const result = lwTryLock(bus, workareaPtr, count);
    if (result.acquired) { regs.setGpr(2, 0); return; }
    regs.setGpr(2, SCE_MUTEX_ERROR_TRYLOCK_FAILED);
  });

  // sceKernelTryLockLwMutex_600 — returns actual error code
  // PPSSPP sceKernelMutex.cpp:911-927
  kernel.register(KERNEL.sceKernelTryLockLwMutex_600, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    const count       = regs.getGpr(5) | 0;
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ACCESS_ERROR); return; }
    const result = lwTryLock(bus, workareaPtr, count);
    if (result.acquired) { regs.setGpr(2, 0); return; }
    regs.setGpr(2, result.error !== 0 ? result.error : SCE_LWMUTEX_ERROR_TRYLOCK_FAILED);
  });

  // sceKernelUnlockLwMutex(workareaPtr, count)
  // PPSSPP sceKernelMutex.cpp:997-1029
  const lwmUnlockHandler = (regs: import("../cpu/registers.js").AllegrexRegisters, bus: import("../memory/memory-bus.js").MemoryBus) => {
    const workareaPtr = regs.getGpr(4);
    const count       = regs.getGpr(5) | 0;
    if (workareaPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ACCESS_ERROR); return; }

    const wa = lwReadWorkarea(bus, workareaPtr);
    if (wa.uid === -1) { regs.setGpr(2, SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX); return; }
    if (count <= 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_COUNT); return; }
    if (count > 1 && !(wa.attr & PSP_MUTEX_ATTR_ALLOW_RECURSIVE)) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_COUNT); return;
    }
    if (wa.lockLevel === 0 || wa.lockThread !== kernel.currentThreadId) {
      regs.setGpr(2, SCE_LWMUTEX_ERROR_NOT_LOCKED); return;
    }
    if (wa.lockLevel < count) { regs.setGpr(2, SCE_LWMUTEX_ERROR_UNLOCK_UNDERFLOW); return; }

    const newLevel = wa.lockLevel - count;
    bus.writeU32(workareaPtr + 0x00, newLevel);

    if (newLevel === 0) {
      const lwm = lwMutexes.get(wa.uid);
      if (lwm && lwWakeNextWaiter(bus, workareaPtr, lwm)) {
        if (!kernel.reschedule(regs)) kernel.idleBreak = true;
      }
    }
    regs.setGpr(2, 0);
  };

  kernel.register(KERNEL.sceKernelUnlockLwMutex, lwmUnlockHandler);
  kernel.register(KERNEL._sceKernelUnlockLwMutex, lwmUnlockHandler);

  // sceKernelReferLwMutexStatus(workareaPtr, infoPtr)
  // PPSSPP sceKernelMutex.cpp:1063-1070
  kernel.register(KERNEL.sceKernelReferLwMutexStatus, (regs, bus) => {
    const workareaPtr = regs.getGpr(4);
    const infoPtr     = regs.getGpr(5);
    if (workareaPtr === 0 || infoPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_ADDR); return; }
    const uid = bus.readU32(workareaPtr + 0x10) | 0;
    const lwm = lwMutexes.get(uid);
    if (!lwm) { regs.setGpr(2, SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX); return; }
    const wa = lwReadWorkarea(bus, workareaPtr);
    // Write NativeLwMutex to infoPtr — PPSSPP __KernelReferLwMutexStatus
    bus.writeU32(infoPtr + 0x00, 0x40); // size = sizeof(NativeLwMutex)
    // Name at offset 0x04, 32 bytes
    for (let i = 0; i < 32; i++) bus.writeU8(infoPtr + 0x04 + i, i < lwm.name.length ? lwm.name.charCodeAt(i) : 0);
    bus.writeU32(infoPtr + 0x24, lwm.attr);
    bus.writeU32(infoPtr + 0x28, uid);
    bus.writeU32(infoPtr + 0x2C, lwm.workareaPtr);
    bus.writeU32(infoPtr + 0x30, lwm.initialCount);
    bus.writeU32(infoPtr + 0x34, wa.lockLevel);
    bus.writeU32(infoPtr + 0x38, wa.lockThread === 0 ? -1 : wa.lockThread); // 0 → -1 for API
    bus.writeU32(infoPtr + 0x3C, lwm.waitingThreads.length);
    regs.setGpr(2, 0);
  });

  // sceKernelReferLwMutexStatusByID(uid, infoPtr)
  kernel.register(MUTEX.sceKernelReferLwMutexStatusByID, (regs, bus) => {
    const uid     = regs.getGpr(4);
    const infoPtr = regs.getGpr(5);
    const lwm = lwMutexes.get(uid);
    if (!lwm) { regs.setGpr(2, SCE_LWMUTEX_ERROR_NO_SUCH_LWMUTEX); return; }
    if (infoPtr === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_ADDR); return; }
    const wa = lwReadWorkarea(bus, lwm.workareaPtr);
    bus.writeU32(infoPtr + 0x00, 0x3C);
    for (let i = 0; i < 32; i++) bus.writeU8(infoPtr + 0x04 + i, i < lwm.name.length ? lwm.name.charCodeAt(i) : 0);
    bus.writeU32(infoPtr + 0x24, lwm.attr);
    bus.writeU32(infoPtr + 0x28, uid);
    bus.writeU32(infoPtr + 0x2C, lwm.workareaPtr);
    bus.writeU32(infoPtr + 0x30, lwm.initialCount);
    bus.writeU32(infoPtr + 0x34, wa.lockLevel);
    bus.writeU32(infoPtr + 0x38, wa.lockThread === 0 ? -1 : wa.lockThread);
    bus.writeU32(infoPtr + 0x3C, lwm.waitingThreads.length);
    regs.setGpr(2, 0);
  });

  // ── Event Flags ───────────────────────────────────────────────────────

  interface EventFlag {
    pattern: number;     // current bit pattern (u32)
    attr: number;        // creation attributes
  }
  const eventFlags = kernel.eventFlags;

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
    const timeoutPtr = regs.getGpr(8); // PARAM(4) = $t0 — pointer to timeout in microseconds
    const evf = eventFlags.get(id);
    if (!evf) { regs.setGpr(2, 0x8002019a >>> 0); return; }
    // Check if condition already met
    if (evfCondMet(evf.pattern, bits, waitMode)) {
      if (outBitsPtr !== 0) bus.writeU32(outBitsPtr, evf.pattern);
      evfApplyClear(evf, bits, waitMode);
      regs.setGpr(2, 0);
      return;
    }
    // Waiting is illegal in interrupt/GE-callback context (see waitSema)
    if (kernel.inInterrupt) {
      regs.setGpr(2, 0x800201a7); // SCE_KERNEL_ERROR_CAN_NOT_WAIT
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
      t.isProcessingCallbacks = cb; // per-wait (PPSSPP processCallbacks param)
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      // Schedule timeout via CoreTiming if a timeout pointer is provided
      if (timeoutPtr !== 0 && kernel.coreTiming && kernel.wakeThreadEventId >= 0) {
        const usec = bus.readU32(timeoutPtr);
        if (usec > 0) {
          const cycles = kernel.coreTiming.usToCycles(usec);
          kernel.coreTiming.scheduleEvent(cycles, kernel.wakeThreadEventId, kernel.currentThreadId);
        } else {
          // Timeout = 0: immediate timeout (poll mode)
          t.state = ThreadState.READY;
          t.waitType = WaitType.NONE;
          if (outBitsPtr !== 0) bus.writeU32(outBitsPtr, evf.pattern);
          t.context.gpr[2] = 0x800201a8 >>> 0; // SCE_KERNEL_ERROR_WAIT_TIMEOUT
        }
      }
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
  // SCE_KERNEL_ERROR_NO_MEMORY already declared above for VPL

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
  kernel.register(FPL.sceKernelCreateFpl, (regs) => {
    const blockSize = regs.getGpr(7);
    // PPSSPP reads 5th arg from $t0 (r8), not stack: PARAM(4) = r[MIPS_REG_A0 + 4] = r[8]
    const numBlocks = Math.max(1, Math.min(regs.getGpr(8) | 0, 4096));
    const fplId = kernel.nextBlockId++;
    const aligned = (blockSize + 3) & ~3; // 4-byte align (PPSSPP uses BlockAllocator)
    const totalSize = aligned * numBlocks;
    const addr = kernel.userMemory.alloc(totalSize, false, "FPL");
    if (addr === -1) { regs.setGpr(2, 0x800200d9 >>> 0); return; }
    fpls.set(fplId, { base: addr, blockSize: aligned, numBlocks, freeBlocks: new Array(numBlocks).fill(true) });
    kernel.memBlocks.set(fplId, { addr, size: totalSize, name: "FPL" });
    regs.setGpr(2, fplId);
  });

  // sceKernelDeleteFpl
  kernel.register(FPL.sceKernelDeleteFpl, (regs) => {
    const fplId = regs.getGpr(4);
    if (!fpls.has(fplId)) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_FPLID); return; }
    // Wake waiting threads with WAIT_DELETE error
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.FPL && t.waitFplId === fplId) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201b5 >>> 0; // SCE_KERNEL_ERROR_WAIT_DELETE
      }
    }
    fpls.delete(fplId);
    kernel.memBlocks.delete(fplId);
    regs.setGpr(2, 0);
  });

  // sceKernelAllocateFpl(fplId, dataPtr, timeout)
  // Blocks if no blocks available (PPSSPP sceKernelMemory.cpp:639)
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
      // Block the thread until a block is freed
      const t = kernel.threads.get(kernel.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.FPL;
        t.waitFplId = fplId;
        t.waitFplDataPtr = dataPtr;
        t.isProcessingCallbacks = false; // plain wait never runs callbacks
        kernel.saveContext(t, regs);
        t.context.gpr[2] = 0;
        if (!kernel.reschedule(regs)) kernel.idleBreak = true;
      } else {
        regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY);
      }
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
      // Wake any threads waiting for a block in this FPL
      for (const t of kernel.threads.values()) {
        if (t.state === ThreadState.WAITING && t.waitType === WaitType.FPL && t.waitFplId === fplId) {
          const newBlock = fplAlloc(fpl);
          if (newBlock >= 0 && t.waitFplDataPtr !== 0) {
            kernel.bus.writeU32(t.waitFplDataPtr, fpl.base + fpl.blockSize * newBlock);
            t.state = ThreadState.READY;
            t.waitType = WaitType.NONE;
            t.context.gpr[2] = 0;
            kernel.reschedule(regs);
            break; // Only wake one thread per free
          }
        }
      }
    } else {
      regs.setGpr(2, 0x800201b6 >>> 0); // SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCK
    }
  });

  // ── VPL (variable pool list) — PPSSPP sceKernelMemory.cpp ────────────

  // sceKernelCreateVpl(name, partition, attr, vplSize, option)
  // PPSSPP: vplSize aligned to 8, min 0x1000 if <=0x30. Pool = vplSize-0x20.
  kernel.register(VPL.sceKernelCreateVpl, (regs) => {
    let vplSize = regs.getGpr(7);
    if (vplSize === 0) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_MEMSIZE_VPL); return; }
    if (vplSize <= 0x30) vplSize = 0x1000;
    vplSize = (vplSize + 7) & ~7;

    const memBlockPtr = kernel.userMemory.alloc(vplSize, false, "VPL");
    if (memBlockPtr === -1) { regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY); return; }

    const vplId = kernel.nextBlockId++;
    const firstBlockOffset = 0x18;
    const lastBlockOffset = vplSize - 8;
    // Initial state: one big free block from firstBlockOffset to lastBlockOffset
    const totalBlocks = (lastBlockOffset - firstBlockOffset) / 8;
    const state: VplState = {
      memBlockPtr,
      vplSize,
      poolAddr: memBlockPtr + 0x20,
      poolSize: vplSize - 0x20,
      blocks: [{ offset: firstBlockOffset, sizeInBlocks: totalBlocks, free: true }],
      firstBlockOffset,
      lastBlockOffset,
    };
    vpls.set(vplId, state);
    kernel.memBlocks.set(vplId, { addr: memBlockPtr, size: vplSize, name: "VPL" });
    log.debug(`sceKernelCreateVpl(size=${regs.getGpr(7)}) → id=${vplId} mem=0x${memBlockPtr.toString(16)} pool=${state.poolSize}`);
    regs.setGpr(2, vplId);
  });

  // sceKernelDeleteVpl
  kernel.register(VPL.sceKernelDeleteVpl, (regs) => {
    const uid = regs.getGpr(4);
    const vpl = vpls.get(uid);
    if (!vpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VPLID); return; }
    // Wake waiting threads with WAIT_DELETE error
    for (const t of kernel.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.VPL && t.waitVplId === uid) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0x800201b5 >>> 0; // SCE_KERNEL_ERROR_WAIT_DELETE
      }
    }
    vpls.delete(uid);
    kernel.memBlocks.delete(uid);
    regs.setGpr(2, 0);
  });

  // sceKernelAllocateVpl(vplId, size, addrPtr, timeout) — blocking
  const allocateVplImpl = (regs: Parameters<Parameters<typeof kernel.register>[1]>[0], bus: Parameters<Parameters<typeof kernel.register>[1]>[1]): void => {
    const vplId   = regs.getGpr(4);
    const size    = regs.getGpr(5);
    const addrPtr = regs.getGpr(6);
    const vpl = vpls.get(vplId);
    if (!vpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VPLID); return; }
    if (size === 0 || size > vpl.poolSize) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_MEMSIZE_VPL); return; }

    const addr = vplAlloc(vpl, size);
    if (addr !== -1 && addrPtr !== 0) {
      bus.writeU32(addrPtr, addr);
      log.debug(`sceKernelAllocateVpl(id=${vplId}, size=${size}) → 0x${addr.toString(16)}`);
      regs.setGpr(2, 0);
      return;
    }

    // Block the thread until memory is freed
    const t = kernel.threads.get(kernel.currentThreadId);
    if (t) {
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.VPL;
      t.waitVplId = vplId;
      t.waitVplSize = size;
      t.waitVplAddrPtr = addrPtr;
      t.isProcessingCallbacks = false; // plain wait never runs callbacks
      kernel.saveContext(t, regs);
      t.context.gpr[2] = 0;
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY);
    }
  };
  kernel.register(VPL.sceKernelAllocateVpl, allocateVplImpl);
  kernel.register(KERNEL.sceKernelAllocateVplCB, allocateVplImpl);

  // sceKernelTryAllocateVpl(vplId, size, addrPtr) — non-blocking
  kernel.register(VPL.sceKernelTryAllocateVpl, (regs, bus) => {
    const vplId   = regs.getGpr(4);
    const size    = regs.getGpr(5);
    const addrPtr = regs.getGpr(6);
    const vpl = vpls.get(vplId);
    if (!vpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VPLID); return; }
    if (size === 0 || size > vpl.poolSize) { regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_MEMSIZE_VPL); return; }

    const addr = vplAlloc(vpl, size);
    if (addr !== -1 && addrPtr !== 0) {
      bus.writeU32(addrPtr, addr);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, SCE_KERNEL_ERROR_NO_MEMORY);
    }
  });

  // sceKernelFreeVpl(vplId, addr)
  kernel.register(VPL.sceKernelFreeVpl, (regs) => {
    const vplId = regs.getGpr(4);
    const addr  = regs.getGpr(5);
    const vpl = vpls.get(vplId);
    if (!vpl) { regs.setGpr(2, SCE_KERNEL_ERROR_UNKNOWN_VPLID); return; }
    if (!vplFree(vpl, addr)) {
      regs.setGpr(2, SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCK_VPL);
      return;
    }
    regs.setGpr(2, 0);
    // Wake any threads waiting for VPL memory
    vplWakeWaiters(vpl, vplId, regs);
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

    // PPSSPP: NULL name returns SCE_KERNEL_ERROR_ILLEGAL_ARGUMENT
    if (namePtr === 0) {
      regs.setGpr(2, 0x80020001 >>> 0); // SCE_KERNEL_ERROR_ILLEGAL_ARGUMENT
      return;
    }
    // PPSSPP sceKernelMemory.cpp:871 — valid types are 0-4
    if (allocType < 0 || allocType > 4) {
      regs.setGpr(2, 0x800200d8 >>> 0); // SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCKTYPE
      return;
    }
    // Size 0 or overflow
    if (size === 0 || size > 0x7FFFFFFF) {
      regs.setGpr(2, 0x800200d9 >>> 0); // SCE_KERNEL_ERROR_MEMBLOCK_ALLOC_FAILED
      return;
    }

    let name = "";
    for (let i = 0; i < 32; i++) {
      const b = bus.readU8(namePtr + i);
      if (b === 0) break;
      name += String.fromCharCode(b);
    }

    // PPSSPP sceKernelMemory.cpp: dispatch to BlockAllocator based on type
    let addr: number;
    if (allocType === 2) {
      // PSP_SMEM_Addr — allocate at specific address
      addr = kernel.userMemory.allocAt(addrHint, size, name);
    } else if (allocType === 3) {
      // PSP_SMEM_LowAligned — low allocation with alignment from addrHint
      const alignment = Math.max(addrHint || 256, 256);
      addr = kernel.userMemory.allocAligned(size, 0x100, alignment, false, name);
    } else if (allocType === 4) {
      // PSP_SMEM_HighAligned — high allocation with alignment from addrHint
      const alignment = Math.max(addrHint || 256, 256);
      addr = kernel.userMemory.allocAligned(size, 0x100, alignment, true, name);
    } else if (allocType === 1) {
      // PSP_SMEM_High — allocate from top
      addr = kernel.userMemory.alloc(size, true, name);
    } else {
      // PSP_SMEM_Low (0) — allocate from bottom
      addr = kernel.userMemory.alloc(size, false, name);
    }
    if (addr === -1) {
      regs.setGpr(2, 0x800200d9 >>> 0); // SCE_KERNEL_ERROR_MEMBLOCK_ALLOC_FAILED
      return;
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
    const blockId = regs.getGpr(4);
    const block = kernel.memBlocks.get(blockId);
    if (block) {
      kernel.userMemory.free(block.addr);
      kernel.memBlocks.delete(blockId);
    }
    regs.setGpr(2, 0);
  });

  // sceKernelMaxFreeMemSize — largest contiguous allocatable block
  kernel.register(SYSMEM.sceKernelMaxFreeMemSize, (regs) => {
    regs.setGpr(2, kernel.userMemory.getLargestFreeBlockSize() >>> 0);
  });

  // sceKernelTotalFreeMemSize — total free memory
  kernel.register(SYSMEM.sceKernelTotalFreeMemSize, (regs) => {
    regs.setGpr(2, kernel.userMemory.getTotalFreeBytes() >>> 0);
  });

  // sceKernelMemset(addr, fillByte, n) — also serves as sce_paf_private_memset
  kernel.register(SYSMEM.sceKernelMemset, (regs, bus) => {
    const addr = regs.getGpr(4);
    const fill = regs.getGpr(5) & 0xFF;
    const n    = regs.getGpr(6);
    for (let i = 0; i < n; i++) bus.writeU8(addr + i, fill);
    regs.setGpr(2, addr); // returns dest pointer
  });

  // sceKernelMemcpy(dest, src, n) — also serves as sce_paf_private_memcpy
  // NID 0x1839852A from Kernel_Library. Forward copy (NOT memmove).
  kernel.register(SYSMEM.sceKernelMemcpy, (regs, bus) => {
    const dest = regs.getGpr(4);
    const src  = regs.getGpr(5);
    const n    = regs.getGpr(6);
    for (let i = 0; i < n; i++) bus.writeU8(dest + i, bus.readU8(src + i));
    regs.setGpr(2, dest);
  });

  // ── SysMem user-level block allocation ──────────────────────────────

  // AllocMemoryBlock(name, type, size, param) — PPSSPP sceKernelMemory.cpp:1630
  kernel.register(SYSMEM.AllocMemoryBlock, (regs) => {
    const namePtr   = regs.getGpr(4);
    const type      = regs.getGpr(5);
    const size      = regs.getGpr(6);
    const paramsPtr = regs.getGpr(7);

    // Validate params struct: if provided, first u32 must be 4
    if (paramsPtr !== 0 && kernel.bus.readU32(paramsPtr) !== 4) {
      regs.setGpr(2, 0x800200d2 >>> 0); return; // SCE_KERNEL_ERROR_ILLEGAL_ARGUMENT
    }
    // Only type 0 (low) and 1 (high) are valid
    if (type !== 0 && type !== 1) {
      regs.setGpr(2, 0x800200d8 >>> 0); return; // SCE_KERNEL_ERROR_ILLEGAL_MEMBLOCKTYPE
    }
    // Size 0 or overflow
    if (size === 0 || size > 0x7FFFFFFF) {
      regs.setGpr(2, 0x800200d9 >>> 0); return; // SCE_KERNEL_ERROR_MEMBLOCK_ALLOC_FAILED
    }
    // NULL name
    if (namePtr === 0) {
      regs.setGpr(2, 0x80020001 >>> 0); return; // SCE_KERNEL_ERROR_ERROR
    }

    const addr = kernel.userMemory.alloc(size, type === 1, "UserBlock");
    if (addr === -1) {
      regs.setGpr(2, 0x800200d9 >>> 0); return; // SCE_KERNEL_ERROR_MEMBLOCK_ALLOC_FAILED
    }
    const uid = kernel.nextBlockId++;
    kernel.memBlocks.set(uid, { addr, size, name: "UserBlock" });
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
    }
    // PPSSPP: always returns 0 even for invalid UIDs
    regs.setGpr(2, 0);
  });

  // FreeMemoryBlock(uid)
  kernel.register(SYSMEM.FreeMemoryBlock, (regs) => {
    const uid = regs.getGpr(4);
    const block = kernel.memBlocks.get(uid);
    if (block) {
      kernel.userMemory.free(block.addr);
      kernel.memBlocks.delete(uid);
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x800200cb >>> 0); // SCE_KERNEL_ERROR_UNKNOWN_UID
    }
  });

  // ── SDK / compiler version stubs ─────────────────────────────────────

  // sceKernelSetCompiledSdkVersion603_605
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion603_605, (regs) => {
    kernel.compiledSdkVersion = regs.getGpr(4);
    log.debug(`sceKernelSetCompiledSdkVersion(0x${kernel.compiledSdkVersion.toString(16)})`);
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
    kernel.compiledSdkVersion = regs.getGpr(4);
    log.debug(`sceKernelSetCompiledSdkVersion(0x${kernel.compiledSdkVersion.toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion350_360
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion350_360, (regs) => {
    kernel.compiledSdkVersion = regs.getGpr(4);
    log.debug(`sceKernelSetCompiledSdkVersion350_360(0x${kernel.compiledSdkVersion.toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion370
  kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion370, (regs) => {
    kernel.compiledSdkVersion = regs.getGpr(4);
    log.debug(`sceKernelSetCompiledSdkVersion370(0x${kernel.compiledSdkVersion.toString(16)})`);
    regs.setGpr(2, 0);
  });

  // sceKernelSetCompiledSdkVersion380_390 — NID missing from nids.ts, keep as-is
  // kernel.register(SYSMEM.sceKernelSetCompiledSdkVersion380_390, ...);

  // sceKernelGetCompiledSdkVersion
  kernel.register(SYSMEM.sceKernelGetCompiledSdkVersion, (regs) => {
    regs.setGpr(2, kernel.compiledSdkVersion);
  });

  // sceKernelDcacheWritebackRange — PPSSPP sceKernel.cpp: validate size >= 0
  kernel.register(SYSMEM.sceKernelDcacheWritebackRange, (regs) => {
    regs.setGpr(2, (regs.getGpr(5) | 0) < 0 ? 0x800200d5 : 0);
  });
  kernel.register(SYSMEM.sceKernelDcacheWritebackInvalidateRange, (regs) => {
    regs.setGpr(2, (regs.getGpr(5) | 0) < 0 ? 0x800200d5 : 0);
  });

  // ── Stubs (no-op / unimplemented) ───────────────────────────────────

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
