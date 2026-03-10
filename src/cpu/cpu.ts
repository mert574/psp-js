import { AllegrexRegisters } from "./registers.js";
import { MemoryBus } from "../memory/memory-bus.js";
import { decodeInstruction } from "./decoder.js";
import { executeInstruction } from "./executor.js";
import type { HLEKernel } from "../kernel/hle-kernel.js";

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
 */
export class SyscallException {
  constructor(readonly code: number) {}
}

export class AllegrexCPU {
  readonly regs = new AllegrexRegisters();

  /** When true, the *next* instruction is in a branch-delay slot. */
  inDelaySlot: boolean = false;
  delaySlotTarget: number = 0;

  /** Set to true when step() returns false due to a fault. */
  stepFaulted: boolean = false;

  /** Attach an HLE kernel to handle SYSCALL instructions. */
  hle: HLEKernel | null = null;

  constructor(readonly bus: MemoryBus) {}

  // Circular buffer for last N PCs (debug trace)
  private traceBuffer = new Uint32Array(16);
  private traceIdx = 0;

  /** Execute a single instruction. Returns false if an unrecoverable error occurs. */
  step(): boolean {
    this.stepFaulted = false;
    const pc = this.regs.pc;

    this.traceBuffer[this.traceIdx & 15] = pc;
    this.traceIdx++;

    // If PC=0, module_start returned — check for pending thread
    if (pc === 0 && this.hle?.pendingThreadEntry != null) {
      const entry = this.hle.pendingThreadEntry;
      this.hle.pendingThreadEntry = null;
      this.regs.pc = entry;
      this.regs.setGpr(31, 0); // $ra = 0 for the thread
      console.log(`[CPU] Starting thread at 0x${entry.toString(16)}`);
      return true;
    }

    let raw: number;
    try {
      raw = this.bus.readU32(pc);
    } catch (e) {
      // Dump recent PC trace
      const trace = [];
      for (let i = Math.max(0, this.traceIdx - 16); i < this.traceIdx; i++) {
        trace.push('0x' + this.traceBuffer[i & 15]!.toString(16));
      }
      console.error(`[CPU] Fetch fault at PC=0x${pc.toString(16)}: ${e}`);
      console.error(`[CPU] Recent PCs: ${trace.join(' → ')}`);
      this.stepFaulted = true;
      return false;
    }

    this.regs.pc = pc + 4;

    const instr = decodeInstruction(raw, pc);

    const inDelaySlot = this.inDelaySlot;
    const delayTarget = this.delaySlotTarget;
    this.inDelaySlot = false;

    try {
      executeInstruction(this, instr);
    } catch (e) {
      if (e instanceof SyscallException) {
        if (this.hle) {
          this.hle.dispatch(e.code, this.regs);
          if (this.stepFaulted) return false;
        } else {
          console.warn(`[CPU] SYSCALL 0x${e.code.toString(16)} with no HLE kernel attached`);
          this.regs.setGpr(2, 0x80020001);
        }
      } else {
        console.error(`[CPU] Execute fault at PC=0x${pc.toString(16)}: ${e}`);
        this.stepFaulted = true;
        return false;
      }
    }

    // After a delay-slot instruction, jump to the branch target.
    if (inDelaySlot) {
      this.regs.pc = delayTarget;
    }

    return true;
  }

  /** Run until `step()` returns false or `maxSteps` is reached. */
  run(maxSteps = Infinity): void {
    let steps = 0;
    while (steps < maxSteps) {
      if (!this.step()) break;
      steps++;
    }
  }
}
