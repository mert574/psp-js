/**
 * AllegrexRegisters
 *
 * The PSP's CPU is an Allegrex — a custom MIPS R4000 derivative.
 * It has the standard 32 general-purpose registers plus the hi/lo
 * multiply result registers, a program counter, and a few special
 * coprocessor-0 registers we need for basic operation.
 *
 * All values are stored as unsigned 32-bit integers.
 *
 * Register conventions (ABI):
 *   $zero (r0)  — always 0
 *   $at   (r1)  — assembler temp
 *   $v0-$v1     — return values
 *   $a0-$a3     — function arguments
 *   $t0-$t9     — temporaries
 *   $s0-$s7     — saved temporaries
 *   $k0-$k1     — kernel reserved
 *   $gp   (r28) — global pointer
 *   $sp   (r29) — stack pointer
 *   $fp   (r30) — frame pointer
 *   $ra   (r31) — return address
 */
export class AllegrexRegisters {
  /** General purpose registers r0–r31. r0 is always 0. */
  readonly gpr: Uint32Array = new Uint32Array(32);

  /** Program counter — points to the current instruction. */
  pc: number = 0;

  /** High 32 bits of multiply/divide result. */
  hi: number = 0;
  /** Low 32 bits of multiply/divide result. */
  lo: number = 0;

  // ── CP0 registers we care about ─────────────────────────────────────────

  /** CP0 r12 — Status register (interrupt enable, operating mode, …) */
  cp0Status: number = 0;
  /** CP0 r13 — Cause register (exception code, branch delay flag, …) */
  cp0Cause: number = 0;
  /** CP0 r14 — Exception PC (address of instruction that caused exception) */
  cp0EPC: number = 0;

  /** Write to a GPR, silently ignoring writes to r0. */
  setGpr(index: number, value: number): void {
    if (index !== 0) {
      this.gpr[index] = value >>> 0;
    }
  }

  /** Read a GPR (always returns 0 for r0). */
  getGpr(index: number): number {
    return this.gpr[index]! >>> 0;
  }
}
