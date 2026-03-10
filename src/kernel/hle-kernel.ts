import type { MemoryBus } from "../memory/memory-bus.js";
import type { AllegrexRegisters } from "../cpu/registers.js";

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
    console.log(`[HLE] Remapped ${mapped} syscalls (${unmapped} unimplemented NIDs)`);
  }

  /** Dispatch a syscall. The syscall code is the lower 20 bits of the SYSCALL instruction. */
  dispatch(syscallCode: number, regs: AllegrexRegisters): void {
    const handler = this.handlers.get(syscallCode);
    if (!handler) {
      const nid = this.syscallToNid.get(syscallCode);
      const nidStr = nid != null ? `NID=0x${nid.toString(16).padStart(8, "0")}` : "unknown";
      console.warn(`[HLE] Unimplemented syscall 0x${syscallCode.toString(16).padStart(5, "0")} (${nidStr})`);
      regs.setGpr(2, 0); // return success to avoid game bail-out
      return;
    }
    handler(regs, this.bus);
  }

  // ── Built-in module registrations ──────────────────────────────────────────

  private registerBuiltins(): void {
    this.registerThreadManagement();
    this.registerDisplay();
    this.registerController();
    this.registerIo();
    this.registerUtils();
  }

  // ── ThreadManForKernel / sceKernelLibrary ────────────────────────────────

  private registerThreadManagement(): void {
    // sceKernelExitGame — terminate the program cleanly
    this.register(0x05572a5f, (regs) => {
      console.log("[HLE] sceKernelExitGame");
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
    this.register(0xc9b4595c, (regs) => {
      const entry = regs.getGpr(5); // $a1 = entry point
      const stackSize = regs.getGpr(7); // $a3 = stack size
      const tid = this.nextThreadId++;
      this.threads.set(tid, { entry, stackSize });
      console.log(`[HLE] sceKernelCreateThread(entry=0x${entry.toString(16)}, stack=${stackSize}) → tid=${tid}`);
      regs.setGpr(2, tid);
    });

    // sceKernelStartThread(thid, arglen, argp)
    this.register(0xf475845d, (regs) => {
      const thid = regs.getGpr(4); // $a0 = thread ID
      const thread = this.threads.get(thid);
      if (thread) {
        console.log(`[HLE] sceKernelStartThread(tid=${thid}) → entry=0x${thread.entry.toString(16)}`);
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

  // ── sceDisplay ───────────────────────────────────────────────────────────

  private registerDisplay(): void {
    // sceDisplaySetMode(mode, width, height)
    this.register(0x0e20f177, (regs) => {
      const mode   = regs.getGpr(4);
      const width  = regs.getGpr(5);
      const height = regs.getGpr(6);
      console.log(`[HLE] sceDisplaySetMode(${mode}, ${width}, ${height})`);
      regs.setGpr(2, 0);
    });

    // sceDisplaySetFrameBuf(topaddr, bufferwidth, pixelformat, sync)
    this.register(0x289d82fe, (regs, _bus) => {
      this.framebufAddr   = regs.getGpr(4);
      this.framebufWidth  = regs.getGpr(5);
      this.framebufFormat = regs.getGpr(6);
      console.log(`[HLE] sceDisplaySetFrameBuf(0x${this.framebufAddr.toString(16)}, ${this.framebufWidth}, ${this.framebufFormat})`);
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
        console.log(`[PSP stdout] ${text.replace(/\n$/, "")}`);
      }
      regs.setGpr(2, size);
    });
  }

  // ── sceUtils / sceMisc ───────────────────────────────────────────────────

  private registerUtils(): void {
    // sceKernelPrintf — variadic, just log as best we can
    this.register(0x7c5be7cb, (regs, bus) => {
      const fmtPtr = regs.getGpr(4);
      let fmt = "";
      let i = 0;
      while (true) {
        const b = bus.readU8(fmtPtr + i++);
        if (b === 0) break;
        fmt += String.fromCharCode(b);
      }
      console.log(`[PSP] ${fmt.replace(/\n$/, "")}`);
      regs.setGpr(2, 0);
    });
  }
}
