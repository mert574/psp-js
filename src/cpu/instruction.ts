/**
 * Decoded MIPS instruction fields.
 *
 * Every 32-bit MIPS instruction can be decomposed into these fields
 * depending on its format (R, I, or J):
 *
 *  R-format:  opcode(6) rs(5) rt(5) rd(5) shamt(5) funct(6)
 *  I-format:  opcode(6) rs(5) rt(5) imm(16)
 *  J-format:  opcode(6) target(26)
 *
 * We decode everything upfront and store it in this flat struct.
 */
export interface Instruction {
  /** Raw 32-bit word */
  raw: number;
  /** PC of this instruction (for relative calculations) */
  pc: number;

  // R / I / J shared
  op: number;     // bits 31-26

  // R-format fields
  rs: number;     // bits 25-21
  rt: number;     // bits 20-16
  rd: number;     // bits 15-11
  shamt: number;  // bits 10-6
  funct: number;  // bits  5-0

  // I-format
  imm16: number;          // bits 15-0, zero-extended
  imm16s: number;         // bits 15-0, sign-extended

  // J-format
  target26: number;       // bits 25-0
}
