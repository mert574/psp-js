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

export class HLEKernel {
  private readonly handlers = new Map<number, HLEHandler>();
  /** Reverse map: syscall code → NID (for debug logging) */
  private syscallToNid = new Map<number, number>();
  /** Pending threads: map from thread UID to entry point address */
  private readonly threads = new Map<number, { entry: number; stackSize: number }>();
  private nextThreadId = 1;
  /** Thread entry to jump to after module_start returns */
  pendingThreadEntry: number | null = null;

  /** Simple bump allocator for sceKernelAllocPartitionMemory */
  private nextAllocAddr = 0x09000000; // start well above typical PRX load area (0x08804000+)
  private readonly memBlocks = new Map<number, { addr: number; size: number; name: string }>();
  private nextBlockId = 0x100;

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
      const nidStr = nid != null ? `NID=0x${nid.toString(16).padStart(8, "0")}` : "unknown";
      log.warn(`Unimplemented syscall 0x${syscallCode.toString(16).padStart(5, "0")} (${nidStr})`);
      regs.setGpr(2, 0); // return success to avoid game bail-out
      return;
    }
    handler(regs, this.bus);
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
  }

  // ── ThreadManForKernel / sceKernelLibrary ────────────────────────────────

  private registerThreadManagement(): void {
    // sceKernelExitGame — terminate the program cleanly
    this.register(0x05572a5f, (regs) => {
      log.info("sceKernelExitGame");
      // Signal the emulator to stop by pointing PC somewhere invalid.
      // The CPU's step() will catch the memory fault and halt.
      regs.pc = 0xdeadbeef;
    });

    // sceKernelSleepThread — suspend current thread (we just return)
    this.register(0x9ace131e, (regs) => {
      regs.setGpr(2, 0); // SCE_OK
    });

    // sceKernelDelayThread(usec) — sleep for microseconds (we skip actual delay)
    this.register(0xceadeb47, (regs) => {
      // a0 = microseconds to sleep
      regs.setGpr(2, 0); // SCE_OK
    });

    // sceKernelCreateThread(name, entry, priority, stackSize, attr, option)
    this.register(0x446d8de6, (regs) => {
      const entry = regs.getGpr(5); // $a1 = entry point
      const stackSize = regs.getGpr(7); // $a3 = stack size
      const tid = this.nextThreadId++;
      this.threads.set(tid, { entry, stackSize });
      log.info(`sceKernelCreateThread(entry=0x${entry.toString(16)}, stack=${stackSize}) → tid=${tid}`);
      regs.setGpr(2, tid);
    });

    // sceKernelStartThread(thid, arglen, argp)
    this.register(0xf475845d, (regs) => {
      const thid = regs.getGpr(4); // $a0 = thread ID
      const thread = this.threads.get(thid);
      if (thread) {
        log.info(`sceKernelStartThread(tid=${thid}) → entry=0x${thread.entry.toString(16)}`);
        this.pendingThreadEntry = thread.entry;
      }
      regs.setGpr(2, 0);
    });

    // sceKernelExitDeleteThread(status)
    this.register(0x809ce29b, (regs) => {
      regs.setGpr(2, 0);
      regs.pc = 0xdeadbeef; // halt
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
      this.nextAllocAddr = aligned + size;

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
      log.info(`sceDisplaySetFrameBuf(0x${this.framebufAddr.toString(16)}, ${this.framebufWidth}, ${this.framebufFormat})`);
      regs.setGpr(2, 0);
    });

    // sceDisplayWaitVblankStart
    this.register(0x984c27e7, (regs) => {
      regs.setGpr(2, 0);
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

    // sceCtrlReadBufferPositive(pad_data*, count) — returns 1 sample, all buttons released
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
  }

  // ── sceUtils / sceMisc ───────────────────────────────────────────────────

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
      regs.setGpr(2, 1); // always thread 1
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

    // sceKernelDelayThreadCB(usec) — same as DelayThread but with callbacks
    this.register(0x68da9e36, (regs) => {
      regs.setGpr(2, 0);
    });

    // sceKernelSleepThreadCB
    this.register(0x82826f70, (regs) => {
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
  }
}
