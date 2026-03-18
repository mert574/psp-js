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

  // ── COP1 (FPU) registers ────────────────────────────────────────────────

  /** FPU registers f0–f31 (single-precision float, stored as raw u32 bits) */
  readonly fpr: Uint32Array = new Uint32Array(32);
  /** FPU condition code flag (used by C.cond.S and BC1T/BC1F) */
  fcr31: number = 0; // FCSR — FPU control/status register

  // ── VFPU registers ──────────────────────────────────────────────────────
  /** VFPU registers: 128 scalars organized as 8 4x4 matrices (float32) */
  readonly vfpr: Float32Array = new Float32Array(128);
  /** VFPU control registers (VFPU_CTRL) */
  readonly vfpuCtrl: Uint32Array = new Uint32Array(16);
  /** VFPU condition register */
  vfpuCc: number = 0;
  /** VFPU prefix state */
  vpfxs: number = 0;
  vpfxt: number = 0;
  vpfxd: number = 0;
  vpfxsEnabled: boolean = false;
  vpfxtEnabled: boolean = false;
  vpfxdEnabled: boolean = false;

  /** Read FPR as float */
  getFpr(index: number): number {
    const buf = new Float32Array(this.fpr.buffer, index * 4, 1);
    return buf[0]!;
  }

  /** Write FPR as float */
  setFpr(index: number, value: number): void {
    const buf = new Float32Array(this.fpr.buffer, index * 4, 1);
    buf[0] = value;
  }

  /** Read FPR raw bits as u32 */
  getFprBits(index: number): number {
    return this.fpr[index]! >>> 0;
  }

  /** Write FPR raw bits from u32 */
  setFprBits(index: number, value: number): void {
    this.fpr[index] = value >>> 0;
  }

  /** Read VFPU scalar raw bits as u32 */
  getVfprBits(index: number): number {
    const view = new DataView(this.vfpr.buffer, this.vfpr.byteOffset);
    return view.getUint32(index * 4, true);
  }

  /** Write VFPU scalar raw bits from u32 */
  setVfprBits(index: number, value: number): void {
    const view = new DataView(this.vfpr.buffer, this.vfpr.byteOffset);
    view.setUint32(index * 4, value, true);
  }

  /** Read VFPU scalar as float */
  getVfpr(index: number): number {
    return this.vfpr[index]!;
  }

  /** Write VFPU scalar as float */
  setVfpr(index: number, value: number): void {
    this.vfpr[index] = value;
  }

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
