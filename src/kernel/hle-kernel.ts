import type { MemoryBus } from "../memory/memory-bus.js";
import type { AllegrexRegisters } from "../cpu/registers.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("HLE");
const pspLog = Logger.get("PSP");

/**
 * HLEKernel
 *
 * High-Level Emulation of the PSP kernel and system libraries.
 *
 * When the CPU executes a SYSCALL instruction the top-level emulator
 * catches it here instead of routing execution into a BIOS ROM image.
 * Each NID (numeric identifier) maps to a handler function that reads
 * arguments from the MIPS ABI registers ($a0–$a3, then stack), does
 * host-side work, and places a return value in $v0 (and $v1 if needed).
 *
 * MIPS O32 calling convention used by the PSP:
 *   $a0 = first argument  (r4)
 *   $a1 = second argument (r5)
 *   $a2 = third argument  (r6)
 *   $a3 = fourth argument (r7)
 *   $v0 = return value    (r2)
 *   $v1 = second return   (r3)  (used by e.g. sceKernelGetSystemTime)
 *
 * PSP syscall encoding:
 *   The game code calls a stub function which executes:
 *     syscall 0x<nid-derived-code>
 *   We decode the NID from the call-table, but for our purposes we
 *   register handlers by their NID directly.
 *
 * Reference: https://github.com/hrydgard/ppsspp (HLE module implementations)
 */

export type HLEHandler = (regs: AllegrexRegisters, bus: MemoryBus) => void;

export interface InputSnapshot {
  buttons: number;
  analog: { x: number; y: number };
}

export enum ThreadState { RUNNING, READY, WAITING, DORMANT, DEAD }
export enum WaitType { NONE, DELAY, VBLANK, SLEEP, SEMA, EVENT_FLAG }

export interface ThreadContext {
  gpr: Uint32Array;  // 32 GPRs
  hi: number; lo: number;
  pc: number;
  fpr: Uint32Array;  // 32 FPRs
  fcr31: number;
}

export interface Thread {
  id: number;
  entry: number;
  stackSize: number;
  stackBase: number;
  stackTop: number;
  k0: number;
  priority: number;
  state: ThreadState;
  waitType: WaitType;
  context: ThreadContext;
  wakeupCount: number;
}

export class HLEKernel {
  private readonly handlers = new Map<number, HLEHandler>();
  /** Reverse map: syscall code → NID (for debug logging) */
  private syscallToNid = new Map<number, number>();
  private warnedSyscalls = new Set<number>();
  /** Threads indexed by thread ID */
  private readonly threads = new Map<number, Thread>();
  private nextThreadId = 1;
  /** Currently running thread ID (0 = main/module_start, before any threads) */
  currentThreadId: number = 0;
  /** Thread entry to jump to after module_start returns (backward compat) */
  pendingThreadEntry: { entry: number; arglen: number; argp: number; sp: number; k0: number } | null = null;

  /** Simple bump allocator for sceKernelAllocPartitionMemory */
  private nextAllocAddr = 0x09000000; // start well above typical PRX load area (0x08804000+)
  private readonly memBlocks = new Map<number, { addr: number; size: number; name: string }>();
  private nextBlockId = 0x100;

  /** GE IDs */
  private nextGeCallbackId = 1;
  private nextGeListId = 1;

  /** Scheduling / timing */
  vblankCount: number = 0;
  cycleCount: number = 0;
  currentButtons: number = 0;

  inputSnapshot: (() => InputSnapshot) | null = null;
  framebufAddr:   number = 0;
  framebufWidth:  number = 512;
  framebufFormat: number = 3;

  constructor(readonly bus: MemoryBus) {
    this.registerBuiltins();
  }

  /** Register a handler for a given NID. */
  register(nid: number, handler: HLEHandler): void {
    this.handlers.set(nid, handler);
  }

  /**
   * Re-register handlers under the syscall codes assigned by the import stub patcher.
   * nidBySyscall maps syscallCode → NID. For each entry where we have a handler
   * registered by NID, we re-register it under the syscall code.
   */
  remapSyscalls(nidBySyscall: Map<number, number>): void {
    // Save original NID→handler map
    const nidHandlers = new Map(this.handlers);
    // Clear and rebuild with syscall codes
    const remapped = new Map<number, HLEHandler>();
    let mapped = 0;
    let unmapped = 0;
    for (const [syscallCode, nid] of nidBySyscall) {
      const handler = nidHandlers.get(nid);
      if (handler) {
        remapped.set(syscallCode, handler);
        mapped++;
      } else {
        unmapped++;
      }
    }
    // Replace handler map — keep NID-based entries too for any direct syscalls
    for (const [code, handler] of remapped) {
      this.handlers.set(code, handler);
    }
    // Store reverse map for debug logging
    this.syscallToNid = new Map(nidBySyscall);
    log.info(`Remapped ${mapped} syscalls (${unmapped} unimplemented NIDs)`);
  }

  /** Dispatch a syscall. The syscall code is the lower 20 bits of the SYSCALL instruction. */
  dispatch(syscallCode: number, regs: AllegrexRegisters): void {
    const handler = this.handlers.get(syscallCode);
    if (!handler) {
      const nid = this.syscallToNid.get(syscallCode);
      // Rate-limit: only log once per unique syscall code
      if (!this.warnedSyscalls.has(syscallCode)) {
        this.warnedSyscalls.add(syscallCode);
        const nidStr = nid != null ? `NID=0x${nid.toString(16).padStart(8, "0")}` : "unknown";
        log.warn(`Unimplemented syscall 0x${syscallCode.toString(16).padStart(5, "0")} (${nidStr})`);
      }
      regs.setGpr(2, 0); // return success to avoid game bail-out
      return;
    }
    handler(regs, this.bus);
  }

  // ── Thread context save/restore & scheduling ───────────────────────────

  /** Save CPU state into thread context */
  saveContext(thread: Thread, regs: AllegrexRegisters): void {
    thread.context.gpr.set(regs.gpr);
    thread.context.hi = regs.hi;
    thread.context.lo = regs.lo;
    thread.context.pc = regs.pc;
    thread.context.fpr.set(regs.fpr);
    thread.context.fcr31 = regs.fcr31;
  }

  /** Restore CPU state from thread context */
  restoreContext(thread: Thread, regs: AllegrexRegisters): void {
    regs.gpr.set(thread.context.gpr);
    regs.hi = thread.context.hi;
    regs.lo = thread.context.lo;
    regs.pc = thread.context.pc;
    regs.fpr.set(thread.context.fpr);
    regs.fcr31 = thread.context.fcr31;
  }

  /** Pick highest-priority READY thread and switch to it. Returns true if a thread was found. */
  reschedule(regs: AllegrexRegisters): boolean {
    // Save current thread
    const current = this.currentThreadId > 0 ? this.threads.get(this.currentThreadId) : null;
    if (current && current.state === ThreadState.RUNNING) {
      current.state = ThreadState.READY;
      this.saveContext(current, regs);
    }

    // Find highest-priority READY thread (lowest priority number = highest priority)
    let best: Thread | null = null;
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.READY) {
        if (!best || t.priority < best.priority) best = t;
      }
    }

    if (best) {
      best.state = ThreadState.RUNNING;
      this.currentThreadId = best.id;
      this.restoreContext(best, regs);
      regs.setGpr(26, best.k0); // $k0 = TCB
      return true;
    }
    return false;
  }

  /** Called each VBlank — wake sleeping threads */
  onVblank(regs: AllegrexRegisters): void {
    this.vblankCount++;
    let woke = false;
    for (const t of this.threads.values()) {
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.VBLANK) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
        woke = true;
      }
      // Wake delay-waiting threads too (simplified: wake every vblank)
      if (t.state === ThreadState.WAITING && t.waitType === WaitType.DELAY) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
        woke = true;
      }
    }
    if (woke) {
      this.reschedule(regs);
    }
  }

  // ── Built-in module registrations ──────────────────────────────────────────

  private registerBuiltins(): void {
    this.registerThreadManagement();
    this.registerMemory();
    this.registerSysMemStubs();
    this.registerDisplay();
    this.registerController();
    this.registerIo();
    this.registerUtils();
    this.registerGe();
    this.registerAudio();
  }

  // ── ThreadManForKernel / sceKernelLibrary ────────────────────────────────

  private registerThreadManagement(): void {
    // sceKernelExitGame — terminate the program cleanly
    this.register(0x05572a5f, (regs) => {
      log.info("sceKernelExitGame");
      regs.pc = 0xdeadbeef;
    });

    // sceKernelSleepThread — block current thread
    this.register(0x9ace131e, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.SLEEP;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceKernelDelayThread(usec) — block with DELAY wait
    this.register(0xceadeb47, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.DELAY;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceKernelDelayThreadCB(usec) — same as DelayThread
    this.register(0x68da9e36, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.DELAY;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceKernelSleepThreadCB
    this.register(0x82826f70, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.SLEEP;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceKernelCreateThread(name, entry, priority, stackSize, attr, option)
    this.register(0x446d8de6, (regs) => {
      const entry = regs.getGpr(5); // $a1 = entry point
      const stackSize = regs.getGpr(7); // $a3 = stack size
      const tid = this.nextThreadId++;

      // Allocate stack from our bump allocator
      const aligned = (stackSize + 0xFF) & ~0xFF; // 256-byte align
      const stackBase = this.nextAllocAddr;
      this.nextAllocAddr = (this.nextAllocAddr + aligned + 0x100) >>> 0; // +256 for k0 TCB

      const stackTop = (stackBase + aligned) >>> 0;
      // k0 TCB is 256 bytes at top of stack; SP is below it
      const k0 = stackTop;
      const sp = stackTop - 256;

      // Initialize k0 TCB area (256 bytes zeroed, then specific fields)
      for (let i = 0; i < 256; i += 4) {
        this.bus.writeU32(k0 + i, 0);
      }
      this.bus.writeU32(k0 + 0xC0, tid);           // thread UID
      this.bus.writeU32(k0 + 0xC8, stackBase);      // initial stack address
      this.bus.writeU32(k0 + 0xF8, 0xFFFFFFFF);
      this.bus.writeU32(k0 + 0xFC, 0xFFFFFFFF);
      // Write thread UID at start of stack too
      this.bus.writeU32(stackBase, tid);

      const ctx: ThreadContext = {
        gpr: new Uint32Array(32),
        hi: 0, lo: 0, pc: 0,
        fpr: new Uint32Array(32),
        fcr31: 0,
      };
      const thread: Thread = {
        id: tid, entry, stackSize, stackBase, stackTop: sp, k0,
        priority: regs.getGpr(6), // $a2 = priority
        state: ThreadState.DORMANT,
        waitType: WaitType.NONE,
        context: ctx,
        wakeupCount: 0,
      };

      this.threads.set(tid, thread);
      log.info(`sceKernelCreateThread(entry=0x${entry.toString(16)}, stack=${stackSize}, sp=0x${sp.toString(16)}, k0=0x${k0.toString(16)}) → tid=${tid}`);
      regs.setGpr(2, tid);
    });

    // sceKernelStartThread(thid, arglen, argp)
    this.register(0xf475845d, (regs) => {
      const thid = regs.getGpr(4);
      const arglen = regs.getGpr(5);
      const argp = regs.getGpr(6);
      const thread = this.threads.get(thid);
      if (thread) {
        // Set up thread entry context
        thread.context.pc = thread.entry;
        thread.context.gpr[4] = arglen;   // $a0
        thread.context.gpr[5] = argp;     // $a1
        thread.context.gpr[26] = thread.k0; // $k0
        thread.context.gpr[29] = thread.stackTop; // $sp
        thread.context.gpr[31] = 0; // $ra = 0 (thread exit on return)
        thread.context.gpr[28] = regs.getGpr(28); // inherit $gp
        thread.state = ThreadState.READY;
        log.info(`sceKernelStartThread(tid=${thid}, arglen=${arglen}, argp=0x${argp.toString(16)})`);
        // If no thread is currently running (we're in module_start), set pendingThreadEntry for backward compat
        if (this.currentThreadId === 0) {
          this.pendingThreadEntry = { entry: thread.entry, arglen, argp, sp: thread.stackTop, k0: thread.k0 };
        }
      }
      regs.setGpr(2, 0);
    });

    // sceKernelExitDeleteThread(status) — mark DEAD, reschedule
    this.register(0x809ce29b, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.DEAD;
        if (!this.reschedule(regs)) {
          regs.pc = 0xdeadbeef; // no more threads
        }
      } else {
        regs.pc = 0xdeadbeef;
      }
    });

    // sceKernelExitThread(status) — mark DEAD, reschedule
    this.register(0xaa73c935, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.DEAD;
        if (!this.reschedule(regs)) {
          regs.pc = 0xdeadbeef;
        }
      } else {
        regs.pc = 0xdeadbeef;
      }
    });

    // sceKernelChangeThreadPriority(thid, priority)
    this.register(0x71bc9871, (regs) => {
      const thid = regs.getGpr(4);
      const newPri = regs.getGpr(5);
      const tid = thid === 0 ? this.currentThreadId : thid;
      const t = this.threads.get(tid);
      if (t) { t.priority = newPri; }
      regs.setGpr(2, 0);
    });

    // sceKernelWakeupThread(thid)
    this.register(0xd59ead2f, (regs) => {
      const thid = regs.getGpr(4);
      const t = this.threads.get(thid);
      if (t && t.state === ThreadState.WAITING && t.waitType === WaitType.SLEEP) {
        t.state = ThreadState.READY;
        t.waitType = WaitType.NONE;
        t.context.gpr[2] = 0;
      }
      regs.setGpr(2, 0);
    });
  }

  // ── SysMemUserForUser (memory management) ──────────────────────────────

  private registerMemory(): void {
    // sceKernelAllocPartitionMemory(partition, name, type, size, addr)
    // Returns a block UID
    this.register(0x237dbd4f, (regs, bus) => {
      const partition = regs.getGpr(4);
      const namePtr   = regs.getGpr(5);
      const allocType = regs.getGpr(6);
      const size      = regs.getGpr(7);

      // Read name string
      let name = "";
      if (namePtr !== 0) {
        for (let i = 0; i < 32; i++) {
          const b = bus.readU8(namePtr + i);
          if (b === 0) break;
          name += String.fromCharCode(b);
        }
      }

      // Simple bump allocator — align to 256 bytes
      const aligned = (this.nextAllocAddr + 0xFF) & ~0xFF;
      const blockId = this.nextBlockId++;
      this.memBlocks.set(blockId, { addr: aligned, size, name });
      this.nextAllocAddr = (aligned + size) >>> 0;

      log.debug(`sceKernelAllocPartitionMemory(part=${partition}, "${name}", type=${allocType}, size=${size}) → uid=${blockId} addr=0x${aligned.toString(16)}`);
      regs.setGpr(2, blockId);
    });

    // sceKernelGetBlockHeadAddr(blockid) → address
    this.register(0x9d9a5ba1, (regs) => {
      const blockId = regs.getGpr(4);
      const block = this.memBlocks.get(blockId);
      const addr = block ? block.addr : 0;
      log.debug(`sceKernelGetBlockHeadAddr(${blockId}) → 0x${addr.toString(16)}`);
      regs.setGpr(2, addr);
    });

    // sceKernelFreePartitionMemory(blockid)
    this.register(0xb6d61d02, (regs) => {
      const blockId = regs.getGpr(4);
      this.memBlocks.delete(blockId);
      regs.setGpr(2, 0);
    });

    // sceKernelMaxFreeMemSize() — return a generous amount
    this.register(0xa291f107, (regs) => {
      regs.setGpr(2, 24 * 1024 * 1024); // 24 MB free
    });

    // sceKernelTotalFreeMemSize()
    this.register(0xf919f628, (regs) => {
      regs.setGpr(2, 24 * 1024 * 1024);
    });

    // sceKernelDcacheWritebackAll — no-op (no cache simulation)
    this.register(0x79d1c3fa, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelDcacheWritebackInvalidateAll — no-op
    this.register(0xb435dec5, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelDcacheWritebackRange — no-op
    this.register(0x3ee30821, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelDcacheWritebackInvalidateRange — no-op
    this.register(0x34b9fa9e, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelIcacheInvalidateAll — no-op
    this.register(0x920f104a, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelIcacheInvalidateRange — no-op
    this.register(0xc2df770e, (regs) => {
      regs.setGpr(2, 0);
    });
  }

  // ── sceDisplay ───────────────────────────────────────────────────────────

  private registerDisplay(): void {
    // sceDisplaySetMode(mode, width, height)
    this.register(0x0e20f177, (regs) => {
      const mode   = regs.getGpr(4);
      const width  = regs.getGpr(5);
      const height = regs.getGpr(6);
      log.info(`sceDisplaySetMode(${mode}, ${width}, ${height})`);
      regs.setGpr(2, 0);
    });

    // sceDisplaySetFrameBuf(topaddr, bufferwidth, pixelformat, sync)
    this.register(0x289d82fe, (regs, _bus) => {
      this.framebufAddr   = regs.getGpr(4);
      this.framebufWidth  = regs.getGpr(5);
      this.framebufFormat = regs.getGpr(6);
      log.debug(`sceDisplaySetFrameBuf(0x${this.framebufAddr.toString(16)}, ${this.framebufWidth}, ${this.framebufFormat})`);
      regs.setGpr(2, 0);
    });

    // sceDisplayWaitVblankStart — block with VBLANK wait
    this.register(0x984c27e7, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.VBLANK;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });
  }

  // ── sceCtrl ──────────────────────────────────────────────────────────────

  private registerController(): void {
    // sceCtrlSetSamplingCycle(cycle)
    this.register(0x6a2774f3, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceCtrlSetSamplingMode(mode)
    this.register(0x1f4011e6, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceCtrlReadBufferPositive(pad_data*, count) — returns 1 sample
    this.register(0x1f803938, (regs, bus) => {
      const padDataPtr = regs.getGpr(4);
      if (padDataPtr !== 0) {
        const snap = this.inputSnapshot ? this.inputSnapshot() : { buttons: 0, analog: { x: 0, y: 0 } };
        const lx = Math.round((snap.analog.x + 1) * 127.5);
        const ly = Math.round((snap.analog.y + 1) * 127.5);
        bus.writeU32(padDataPtr + 0, 0);
        bus.writeU32(padDataPtr + 4, snap.buttons);
        bus.writeU8(padDataPtr + 8, lx);
        bus.writeU8(padDataPtr + 9, ly);
      }
      regs.setGpr(2, 1);
    });
  }

  // ── sceIo ────────────────────────────────────────────────────────────────

  private registerIo(): void {
    // sceIoWrite(fd, data, size) — proxy fd 1/2 to console
    this.register(0x42ec03ac, (regs, bus) => {
      const fd   = regs.getGpr(4);
      const data = regs.getGpr(5);
      const size = regs.getGpr(6);
      if ((fd === 1 || fd === 2) && size > 0) {
        const bytes: number[] = [];
        for (let i = 0; i < size; i++) bytes.push(bus.readU8(data + i));
        const text = new TextDecoder().decode(new Uint8Array(bytes));
        pspLog.info(`${text.replace(/\n$/, "")}`);
      }
      regs.setGpr(2, size);
    });

    // sceIoOpen(filename, flags, mode) — return error (no filesystem)
    this.register(0x109f50bc, (regs) => {
      regs.setGpr(2, 0x80010002); // SCE_ERROR_ERRNO_ENOENT
    });

    // sceIoClose(fd) — return 0
    this.register(0x810c4bc3, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceIoRead(fd, data, size) — return 0 (EOF)
    this.register(0x6a638d83, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceIoLseek(fd, offset, whence) — return 0
    this.register(0x27eb27b8, (regs) => {
      regs.setGpr(2, 0);
      regs.setGpr(3, 0);
    });

    // sceIoLseek32(fd, offset, whence) — return 0
    this.register(0x68963324, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceIoGetstat(file, stat) — return error
    this.register(0xace946e8, (regs) => {
      regs.setGpr(2, 0x80010002);
    });

    // sceIoChdir(path) — return 0
    this.register(0x55f4717d, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceIoDopen(dirname) — return error
    this.register(0xb29ddf9c, (regs) => {
      regs.setGpr(2, 0x80010002);
    });

    // sceIoDclose(fd) — return 0
    this.register(0xeb092469, (regs) => {
      regs.setGpr(2, 0);
    });
  }

  // ── sceGe ────────────────────────────────────────────────────────────────

  private registerGe(): void {
    // sceGeEdramGetAddr — return VRAM start
    this.register(0xe47e40e4, (regs) => {
      regs.setGpr(2, 0x04000000);
    });

    // sceGeSetCallback(cbdata) — register GE callback, return ID
    this.register(0xa4fc06a4, (regs) => {
      regs.setGpr(2, this.nextGeCallbackId++);
    });

    // sceGeListEnQueue(list, stall, cbid, arg) — queue display list, return list ID
    this.register(0xab49e76a, (regs) => {
      regs.setGpr(2, this.nextGeListId++);
    });

    // sceGeListSync(listId, syncType) — return 0 (completed)
    this.register(0x03444eb4, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceGeDrawSync(syncType) — return 0
    this.register(0xb287bd61, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceGeEdramGetSize — return 2MB
    this.register(0x1f6752ad, (regs) => {
      regs.setGpr(2, 0x00200000);
    });

    // sceGeUnsetCallback(cbId)
    this.register(0x05db22ce, (regs) => {
      regs.setGpr(2, 0);
    });
  }

  // ── sceAudio ─────────────────────────────────────────────────────────────

  private registerAudio(): void {
    // sceAudioChReserve(channel, sampleCount, format) — return channel
    this.register(0x5ec81c55, (regs) => {
      const ch = regs.getGpr(4);
      regs.setGpr(2, ch >= 0 ? ch : 0);
    });

    // sceAudioOutputBlocking(channel, vol, buf) — return sample count
    this.register(0x136caf51, (regs) => {
      regs.setGpr(2, regs.getGpr(5) > 0 ? regs.getGpr(5) : 0);
    });

    // sceAudioOutputPannedBlocking(channel, volL, volR, buf)
    this.register(0x13f592bc, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceAudioChRelease(channel)
    this.register(0x6fc46853, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceAudioGetChannelRestLen
    this.register(0xb7e1d8e7, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceAudioOutput(channel, vol, buf)
    this.register(0x8c1009b2, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceAudioSRCChReserve(samplecount, freq, channels)
    this.register(0x01562ba3, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceAudioSRCOutputBlocking(vol, buf)
    this.register(0x2d53f36e, (regs) => {
      regs.setGpr(2, 0);
    });
  }

  // ── SysMemForKernel (SDK version stubs) ─────────────────────────────────

  private registerSysMemStubs(): void {
    // sceKernelSetCompiledSdkVersion603_605 — just stores SDK version
    this.register(0x1b4217bc, (regs) => {
      log.debug(`sceKernelSetCompiledSdkVersion(0x${regs.getGpr(4).toString(16)})`);
      regs.setGpr(2, 0);
    });

    // sceKernelSetCompilerVersion
    this.register(0xf77d77cb, (regs) => {
      log.debug(`sceKernelSetCompilerVersion(0x${regs.getGpr(4).toString(16)})`);
      regs.setGpr(2, 0);
    });

    // sceKernelDevkitVersion — return a recent firmware version
    this.register(0x3fc9ae6a, (regs) => {
      regs.setGpr(2, 0x06060010); // 6.60
    });

    // sceKernelSetCompiledSdkVersion (generic variant)
    this.register(0x7591c7db, (regs) => {
      log.debug(`sceKernelSetCompiledSdkVersion(0x${regs.getGpr(4).toString(16)})`);
      regs.setGpr(2, 0);
    });

    // AllocMemoryBlock(name, type, size, param) — user-level memory allocation
    this.register(0xfe707fdf, (regs) => {
      const size = regs.getGpr(6);
      const aligned = (size + 0xFF) & ~0xFF;
      const addr = this.nextAllocAddr;
      this.nextAllocAddr = (this.nextAllocAddr + aligned) >>> 0;
      const uid = this.nextBlockId++;
      this.memBlocks.set(uid, { addr, size: aligned, name: "UserBlock" });
      log.debug(`AllocMemoryBlock(size=${size}) → uid=${uid} addr=0x${addr.toString(16)}`);
      regs.setGpr(2, uid);
    });

    // GetMemoryBlockPtr(uid, addr_out)
    this.register(0xdb83a952, (regs) => {
      const uid = regs.getGpr(4);
      const addrOut = regs.getGpr(5);
      const block = this.memBlocks.get(uid);
      if (block && addrOut !== 0) {
        this.bus.writeU32(addrOut, block.addr);
        regs.setGpr(2, 0);
      } else {
        regs.setGpr(2, 0x800200d6); // SCE_KERNEL_ERROR_UNKNOWN_UID
      }
    });

    // FreeMemoryBlock(uid)
    this.register(0x50f61d8a, (regs) => {
      const uid = regs.getGpr(4);
      this.memBlocks.delete(uid);
      regs.setGpr(2, 0);
    });
  }

  // ── sceUtils / sceMisc ───────────────────────────────────────────────────

  private registerUtils(): void {
    // sceKernelPrintf — variadic, just log as best we can
    this.register(0x13a5abef, (regs, bus) => {
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

    // sceKernelGetSystemTimeWide() → i64 microseconds in v0/v1
    this.register(0x82bc5777, (regs) => {
      const us = BigInt(Date.now()) * 1000n;
      regs.setGpr(2, Number(us & 0xFFFFFFFFn));        // v0 = low 32
      regs.setGpr(3, Number((us >> 32n) & 0xFFFFFFFFn)); // v1 = high 32
    });

    // sceKernelGetSystemTimeLow() → u32 low microseconds
    this.register(0x369ed59d, (regs) => {
      regs.setGpr(2, (Date.now() * 1000) >>> 0);
    });

    // sceKernelReferThreadStatus(thid, status_ptr) — stub
    this.register(0x17c1684e, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelGetThreadId() → current thread ID
    this.register(0x293b45b8, (regs) => {
      regs.setGpr(2, this.currentThreadId || 1);
    });

    // sceKernelCheckThreadStack() — return plenty of stack
    this.register(0xd13bde95, (regs) => {
      regs.setGpr(2, 0x4000); // 16KB free
    });

    // sceKernelLoadModule — stub, return fake module ID
    this.register(0x977de386, (regs) => {
      log.debug("sceKernelLoadModule (stub)");
      regs.setGpr(2, 0x80); // fake module ID
    });

    // sceKernelStartModule — stub
    this.register(0x50f0c1ec, (regs) => {
      log.debug("sceKernelStartModule (stub)");
      regs.setGpr(2, 0);
    });

    // sceKernelStopModule — stub
    this.register(0xd1ff982a, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelUnloadModule — stub
    this.register(0x2e0911aa, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelChangeCurrentThreadAttr(removeAttr, addAttr) — stub
    this.register(0xea748e31, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelCreateLwMutex(workarea, name, attr, count, option) — lightweight mutex stub
    this.register(0x19cff145, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceRtcGetCurrentTick(tick_ptr) — write 64-bit tick to pointer
    this.register(0x3f7ad767, (regs) => {
      const ptr = regs.getGpr(4);
      const us = BigInt(Date.now()) * 1000n;
      this.bus.writeU32(ptr, Number(us & 0xFFFFFFFFn));
      this.bus.writeU32(ptr + 4, Number((us >> 32n) & 0xFFFFFFFFn));
      regs.setGpr(2, 0);
    });

    // sceImposeSetLanguageMode(language, button) — stub
    this.register(0x36aa6e91, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelCreateFpl(name, part, attr, blockSize, numBlocks, option) — fixed pool allocator
    this.register(0xc07bb470, (regs) => {
      const blockSize = regs.getGpr(7); // $a3 = block size
      const fplId = this.nextBlockId++;
      const aligned = (blockSize + 0xFF) & ~0xFF;
      const addr = this.nextAllocAddr;
      this.nextAllocAddr = (this.nextAllocAddr + aligned * 16) >>> 0;
      this.memBlocks.set(fplId, { addr, size: aligned * 16, name: "FPL" });
      log.debug(`sceKernelCreateFpl(blockSize=${blockSize}) → fplId=${fplId}`);
      regs.setGpr(2, fplId);
    });

    // sceKernelAllocateFpl(fplId, dataPtr, timeout) — allocate from fixed pool
    this.register(0xd979e9bf, (regs) => {
      const fplId = regs.getGpr(4);
      const dataPtr = regs.getGpr(5);
      const block = this.memBlocks.get(fplId);
      if (block && dataPtr !== 0) {
        this.bus.writeU32(dataPtr, block.addr);
        regs.setGpr(2, 0);
      } else {
        regs.setGpr(2, -1);
      }
    });

    // sceKernelStopUnloadSelfModuleWithStatus — stub, return success
    this.register(0x8f2df740, (regs) => {
      log.debug("sceKernelStopUnloadSelfModuleWithStatus (stub)");
      regs.setGpr(2, 0);
    });

    // sceKernelCreateSema(name, attr, initVal, maxVal, option)
    this.register(0xd6da4ba1, (regs) => {
      const sid = this.nextBlockId++;
      log.debug(`sceKernelCreateSema → ${sid}`);
      regs.setGpr(2, sid);
    });

    // sceKernelDeleteSema
    this.register(0x28b6489c, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelSignalSema
    this.register(0x3f53e640, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelWaitSema
    this.register(0x4e3a1105, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelWaitSemaCB
    this.register(0x6d212bac, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelCreateEventFlag(name, attr, bits, option)
    this.register(0x55c20a00, (regs) => {
      const eid = this.nextBlockId++;
      regs.setGpr(2, eid);
    });

    // sceKernelSetEventFlag
    this.register(0x1fb15a32, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelWaitEventFlag
    this.register(0x402fcf22, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelWaitEventFlagCB
    this.register(0x328c546f, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelDeleteEventFlag
    this.register(0xef9e4c70, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelCreateMutex
    this.register(0xb7d098c6, (regs) => {
      const mid = this.nextBlockId++;
      regs.setGpr(2, mid);
    });

    // sceKernelLockMutex
    this.register(0xb011b11f, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelUnlockMutex
    this.register(0x6b30100f, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelDeleteMutex
    this.register(0xf8170fbe, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceUtilitySavedataInitStart — return not found
    this.register(0x50c4cd57, (regs) => {
      regs.setGpr(2, 0x80110301); // SCE_UTILITY_SAVEDATA_ERROR_RW_NOFILE
    });

    // sceUtilityGetSystemParamInt(id, value_ptr)
    this.register(0x45c18506, (regs, bus) => {
      const id = regs.getGpr(4);
      const ptr = regs.getGpr(5);
      let val = 0;
      switch (id) {
        case 1: val = 1; break;   // PSP_SYSTEMPARAM_ID_INT_LANGUAGE: English
        case 5: val = 0; break;   // PSP_SYSTEMPARAM_ID_INT_DATE_FORMAT: YYYYMMDD
        case 6: val = 1; break;   // PSP_SYSTEMPARAM_ID_INT_TIME_FORMAT: 12hr
        case 7: val = 0; break;   // PSP_SYSTEMPARAM_ID_INT_TIMEZONE: UTC
        case 8: val = 0; break;   // PSP_SYSTEMPARAM_ID_INT_DAYLIGHTSAVINGS: off
        case 9: val = 1; break;   // PSP_SYSTEMPARAM_ID_INT_BUTTON_PREFERENCE: X=confirm
      }
      if (ptr !== 0) bus.writeU32(ptr, val);
      regs.setGpr(2, 0);
    });

    // sceUtilityGetSystemParamString — stub with empty string
    this.register(0x34b78343, (regs, bus) => {
      const ptr = regs.getGpr(5);
      if (ptr !== 0) bus.writeU8(ptr, 0);
      regs.setGpr(2, 0);
    });

    // sceUmdCheckMedium — disc present: return 1
    this.register(0x46ebb729, (regs) => {
      regs.setGpr(2, 1);
    });

    // sceUmdActivate(mode) — stub success
    this.register(0xc6183d47, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceUmdGetDriveStat — return PSP_UMD_PRESENT | PSP_UMD_READY | PSP_UMD_READABLE
    this.register(0x6b4a146c, (regs) => {
      regs.setGpr(2, 0x02 | 0x04 | 0x08); // present | ready | readable
    });

    // sceUmdWaitDriveStat(stat) — return 0 immediately
    this.register(0x8ef08fce, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceUmdRegisterUMDCallBack — stub
    this.register(0xaee7404d, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelCreateCallback(name, func, arg)
    this.register(0xe81caf8f, (regs) => {
      const cbid = this.nextBlockId++;
      regs.setGpr(2, cbid);
    });

    // sceKernelDeleteCallback
    this.register(0xedba5844, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelRegisterExitCallback
    this.register(0x4ac57943, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceRtcGetTickResolution — 1000000 (microseconds)
    this.register(0xc41c2853, (regs) => {
      regs.setGpr(2, 1000000);
    });

    // sceKernelCreateVTimer
    this.register(0x20fff560, (regs) => {
      regs.setGpr(2, this.nextBlockId++);
    });

    // sceKernelStartVTimer
    this.register(0xc68d9437, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelGetVTimerTime
    this.register(0xb3a59970, (regs) => {
      regs.setGpr(2, 0);
      regs.setGpr(3, 0);
    });

    // sceDisplayGetVcount — return vblank count
    this.register(0x9c6eaad7, (regs) => {
      regs.setGpr(2, this.vblankCount);
    });

    // sceDisplayWaitVblank (different from WaitVblankStart)
    this.register(0x36cdfade, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.VBLANK;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceDisplayWaitVblankStartCB
    this.register(0x46f186c3, (regs) => {
      const t = this.threads.get(this.currentThreadId);
      if (t) {
        t.state = ThreadState.WAITING;
        t.waitType = WaitType.VBLANK;
        this.saveContext(t, regs);
        t.context.gpr[2] = 0;
        this.reschedule(regs);
      } else {
        regs.setGpr(2, 0);
      }
    });

    // sceCtrlPeekBufferPositive — same as ReadBufferPositive
    this.register(0x3a622550, (regs, bus) => {
      const padDataPtr = regs.getGpr(4);
      if (padDataPtr !== 0) {
        const snap = this.inputSnapshot ? this.inputSnapshot() : { buttons: 0, analog: { x: 0, y: 0 } };
        const lx = Math.round((snap.analog.x + 1) * 127.5);
        const ly = Math.round((snap.analog.y + 1) * 127.5);
        bus.writeU32(padDataPtr + 0, 0);
        bus.writeU32(padDataPtr + 4, snap.buttons);
        bus.writeU8(padDataPtr + 8, lx);
        bus.writeU8(padDataPtr + 9, ly);
      }
      regs.setGpr(2, 1);
    });

    // sceKernelLockLwMutex(workarea, count, timeout) — stub
    this.register(0x4c145944, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelUnlockLwMutex(workarea, count) — stub
    this.register(0x60107536, (regs) => {
      regs.setGpr(2, 0);
    });
  }
}
