import { AllegrexRegisters } from "./registers.js";
import { MemoryBus } from "../memory/memory-bus.js";
import { MemoryRegion } from "../memory/memory-map.js";
import { decodeInto } from "./decoder.js";
import { executeInstruction } from "./executor.js";
import type { Instruction } from "./instruction.js";
import type { HLEKernel } from "../kernel/hle-kernel.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("CPU");

// Hoisted physical-address bounds for the per-step PC check (hot path).
const CPU_RAM_START = MemoryRegion.RAM_START;
const CPU_RAM_END = MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE;
const CPU_SCRATCH_START = MemoryRegion.SCRATCHPAD_START;
const CPU_SCRATCH_END = MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE;

/**
 * AllegrexCPU
 *
 * Top-level CPU object. Ties together the register file, memory bus,
 * decode stage, and execute stage into a simple fetch→decode→execute loop.
 *
 * The PSP Allegrex is in-order and does not have a branch-delay slot
 * visible to software in all cases, but classic MIPS branch-delay slots
 * *are* present. We track this with `inDelaySlot` and `delaySlotTarget`.
 *
 * HLE note: when the executor throws a SyscallException the CPU catches it
 * here and dispatches to the HLEKernel — no BIOS ROM needed.
 *
 * Scheduling model (mirrors PPSSPP's CoreTiming in simplified form):
 *
 * Each frame the emulator calls `runFrame()` which sets a cycle budget via
 * `run(stepsPerFrame)`.  When a syscall puts the current thread to sleep and
 * `reschedule()` finds no READY threads, the kernel sets `idleBreak` on
 * itself.  The CPU's `run()` loop checks this flag after every syscall
 * dispatch and exits early, allowing the emulator to fire VBlank and wake
 * sleeping threads — exactly like PPSSPP's `CoreTiming::Idle()` fast-
 * forwarding `downcount` to zero.
 */
export class SyscallException {
  constructor(readonly code: number) {}
}

export class AllegrexCPU {
  readonly regs = new AllegrexRegisters();

  /** When true, the *next* instruction is in a branch-delay slot. */
  inDelaySlot: boolean = false;
  delaySlotTarget: number = 0;

  /** Syscall code set by the SYSCALL instruction, or -1 if none this step.
   *  Flag-based instead of a thrown exception: ~2000 syscalls/frame as JS
   *  throws was a real hot-path cost (stack unwinding + deopt). */
  pendingSyscall: number = -1;

  /** Set to true when step() encounters an unrecoverable fault. */
  stepFaulted: boolean = false;

  /** Attach an HLE kernel to handle SYSCALL instructions. */
  hle: HLEKernel | null = null;

  /** Optional callback for BREAK instructions. If it returns true, execution continues. */
  onBreak: ((pc: number) => boolean) | null = null;

  constructor(readonly bus: MemoryBus) {}

  // Circular buffer for last N PCs (debug trace)
  private traceBuffer = new Uint32Array(512);
  private traceIdx = 0;

  /** Reusable decoded-instruction scratch — avoids allocating one object per step. */
  private readonly _instr: Instruction = {
    raw: 0, pc: 0, op: 0, rs: 0, rt: 0, rd: 0,
    shamt: 0, funct: 0, imm16: 0, imm16s: 0, target26: 0,
  };

  /** Optional PC watchpoint for debugging — set to non-zero to log registers at that PC. */
  watchPC: number = 0;

  /** Execute a single instruction. Returns false if an unrecoverable error occurs. */
  step(): boolean {
    this.stepFaulted = false;
    const pc = this.regs.pc;

    this.traceBuffer[this.traceIdx & 511] = pc;
    this.traceIdx++;

    if (this.watchPC && pc === this.watchPC) {
      const r = this.regs;
      const ra = r.getGpr(31);
      const sp = r.getGpr(29);
      // Log all calls at the crash frame or with bad ra
      if (ra === 0 || sp === 0xbfdf090) {
        log.info(`WATCH PC=0x${pc.toString(16)} a0=0x${r.getGpr(4).toString(16)} a1=0x${r.getGpr(5).toString(16)} a2=0x${r.getGpr(6).toString(16)} a3=0x${r.getGpr(7).toString(16)} s0=0x${r.getGpr(16).toString(16)} s1=0x${r.getGpr(17).toString(16)} ra=0x${ra.toString(16)} sp=0x${sp.toString(16)} tid=${this.hle?.currentThreadId ?? -1}`);
      }
    }

    // Catch execution outside valid code regions.
    // PPSSPP: PSP_GetKernelMemoryBase()=RAM_START, PSP_GetUserMemoryEnd()=RAM_START+g_MemorySize.
    // Bounds are module-level consts (CPU_RAM_*/CPU_SCRATCH_*) so this stays a
    // few comparisons per step; scratchpad is only checked off the common path.
    const phys = pc & 0x1FFFFFFF;
    const inRAM = phys >= CPU_RAM_START && phys < CPU_RAM_END;
    if (!inRAM) {
      const inScratch = phys >= CPU_SCRATCH_START && phys < CPU_SCRATCH_END;
      if (!inScratch) {
        const ra = this.regs.getGpr(31);
        const trace = [];
        for (let i = Math.max(0, this.traceIdx - 64); i < this.traceIdx; i++) {
          trace.push('0x' + this.traceBuffer[i & 511]!.toString(16));
        }
        const tid = this.hle?.currentThreadId ?? -1;
        log.error(`Bad PC=0x${pc.toString(16)} ra=0x${ra.toString(16)} sp=0x${this.regs.getGpr(29).toString(16)} thread=${tid}`);
        log.error(`Regs: v0=0x${this.regs.getGpr(2).toString(16)} v1=0x${this.regs.getGpr(3).toString(16)} a0=0x${this.regs.getGpr(4).toString(16)} a1=0x${this.regs.getGpr(5).toString(16)} a2=0x${this.regs.getGpr(6).toString(16)} a3=0x${this.regs.getGpr(7).toString(16)} s0=0x${this.regs.getGpr(16).toString(16)} s1=0x${this.regs.getGpr(17).toString(16)} gp=0x${this.regs.getGpr(28).toString(16)}`);
        log.error(`Last PCs: ${trace.join(' → ')}`);

        // Dump stack memory around sp to find corrupted $ra
        const sp = this.regs.getGpr(29);
        const spPhys = sp & 0x1FFFFFFF;
        if (spPhys >= MemoryRegion.RAM_START && spPhys < MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
          const stackDump: string[] = [];
          // Dump from sp-0x60 to sp+0x60 to catch both the pre-epilogue and post-epilogue frames
          for (let off = -0x60; off <= 0x60; off += 4) {
            try {
              const val = this.bus.readU32(sp + off);
              const label = off >= 0 ? `sp+${off.toString(16).padStart(2,'0')}` : `sp-${(-off).toString(16).padStart(2,'0')}`;
              stackDump.push(`[${label}]=0x${val.toString(16).padStart(8,'0')}`);
            } catch { /* skip invalid */ }
          }
          log.error(`Stack dump: ${stackDump.join(' ')}`);
        }

        // Try to recover by killing the current thread and rescheduling.
        // This mirrors how PPSSPP handles fatal thread errors — the thread dies
        // but the emulator continues with remaining threads.
        this.stepFaulted = true;
        return false;
      }
    }

    // Fetch — the PC was validated above, so RAM fetches can skip the bus's
    // region dispatch entirely (readU32 never throws; it returns 0 for unmapped).
    const raw = inRAM ? this.bus.fetchRamU32(phys) : this.bus.readU32(pc);

    this.regs.pc = pc + 4;

    const instr = this._instr;
    decodeInto(instr, raw, pc);

    const inDelaySlot = this.inDelaySlot;
    const delayTarget = this.delaySlotTarget;
    this.inDelaySlot = false;

    this.pendingSyscall = -1;
    try {
      executeInstruction(this, instr);
    } catch (e) {
      // Only real faults reach here now — SYSCALL uses cpu.pendingSyscall, not a
      // throw, so the common case never pays exception-unwinding cost.
      const trace = [];
      for (let i = Math.max(0, this.traceIdx - 128); i < this.traceIdx; i++) {
        trace.push('0x' + this.traceBuffer[i & 127]!.toString(16));
      }
      log.error(`Execute fault at PC=0x${pc.toString(16)}: ${e}`);
      log.error(`Recent PCs: ${trace.join(' → ')}`);
      this.stepFaulted = true;
      return false;
    }

    if (this.pendingSyscall >= 0) {
      const code = this.pendingSyscall;
      this.pendingSyscall = -1;
      // SYSCALL is typically in a branch delay slot (JR $RA; SYSCALL).
      // Resolve the branch *before* dispatching so the HLE handler sees
      // the correct return PC when it saves thread context.
      if (inDelaySlot) {
        this.regs.pc = delayTarget;
      }
      if (this.hle) {
        const callerThreadId = this.hle.currentThreadId;
        this.hle.dispatch(code, this.regs);
        if (this.stepFaulted) return false;
        // Clobber caller-saved registers to 0xDEADBEEF after syscall,
        // matching PPSSPP's hleFinishSyscall behavior.
        // Skip $v0/$v1 (return values), $s0-$s7 (callee-saved), $k0-$k1/$gp/$sp/$fp/$ra.
        // Don't clobber when a MipsCall is active — the syscall handler set up
        // $a0-$a2 for the callback, and clobbering would destroy them.
        const DEADBEEF = 0xDEADBEEF;
        const callerRegs = [1, 4,5,6,7, 8,9,10,11,12,13,14,15, 24,25];
        if (this.hle.hasMipsCall) {
          // MipsCall dispatched — callback args are live, don't clobber
        } else if (this.hle.currentThreadId === callerThreadId) {
          // No thread switch — clobber live registers directly
          for (const r of callerRegs) this.regs.setGpr(r, DEADBEEF);
          this.regs.hi = DEADBEEF;
          this.regs.lo = DEADBEEF;
        } else {
          // Thread switch occurred — clobber the saved context of the calling thread
          const callerThread = this.hle.threads.get(callerThreadId);
          if (callerThread) {
            for (const r of callerRegs) callerThread.context.gpr[r] = DEADBEEF;
            callerThread.context.hi = DEADBEEF;
            callerThread.context.lo = DEADBEEF;
          }
        }
      } else {
        log.warn(`SYSCALL 0x${code.toString(16)} with no HLE kernel attached`);
        this.regs.setGpr(2, 0x80020001);
      }
      // A syscall resolved the delay slot above; don't re-jump below.
      return true;
    }

    // After a delay-slot instruction, jump to the branch target.
    if (inDelaySlot) {
      this.regs.pc = delayTarget;
    }

    return true;
  }

  /**
   * Run up to `maxSteps` instructions.
   *
   * The loop exits early when:
   *  - step() returns false (fault)
   *  - HLE kernel signals idle (all threads waiting, no work to do)
   *
   * The caller (PSPEmulator.runFrame) distinguishes these cases by checking
   * `stepFaulted` (true = real fault) vs `hle.idleBreak` (true = idle).
   */
  run(maxSteps = Infinity): number {
    let steps = 0;
    // Never stop between a branch and its delay slot: callers treat the end of
    // a slice as a safe point (thread reschedule, GE callback mini-calls), and
    // none of those save/restore inDelaySlot/delaySlotTarget. Splitting the
    // pair leaks a pending jump into whatever context runs next.
    while (steps < maxSteps || this.inDelaySlot) {
      if (!this.step()) break;
      steps++;
      // Check idle after every syscall dispatch — the flag is only set inside
      // reschedule(), which only runs during syscall handling, so this check
      // is cheap (just a boolean read on the hot path).
      if (this.hle?.idleBreak && !this.inDelaySlot) break;
    }
    return steps;
  }
}
