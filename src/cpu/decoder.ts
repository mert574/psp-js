import type { Instruction } from "./instruction.js";

/**
 * decodeInstruction
 *
 * Splits a raw 32-bit MIPS word into its constituent fields.
 * All heavy lifting happens here so the executor can just read
 * pre-decoded values without any masking/shifting.
 */
export function decodeInstruction(raw: number, pc: number): Instruction {
  const op      = (raw >>> 26) & 0x3f;
  const rs      = (raw >>> 21) & 0x1f;
  const rt      = (raw >>> 16) & 0x1f;
  const rd      = (raw >>> 11) & 0x1f;
  const shamt   = (raw >>>  6) & 0x1f;
  const funct   =  raw         & 0x3f;
  const imm16   =  raw         & 0xffff;
  const imm16s  = (imm16 & 0x8000) ? (imm16 | 0xffff0000) : imm16;
  const target26 = raw         & 0x3ffffff;

  return { raw, pc, op, rs, rt, rd, shamt, funct, imm16, imm16s, target26 };
}

/**
 * Decode into a caller-owned Instruction object (no allocation).
 * Used by the CPU hot loop — allocating a fresh object per instruction
 * creates millions of short-lived objects per second.
 */
export function decodeInto(i: Instruction, raw: number, pc: number): void {
  i.raw     = raw;
  i.pc      = pc;
  i.op      = (raw >>> 26) & 0x3f;
  i.rs      = (raw >>> 21) & 0x1f;
  i.rt      = (raw >>> 16) & 0x1f;
  i.rd      = (raw >>> 11) & 0x1f;
  i.shamt   = (raw >>>  6) & 0x1f;
  i.funct   =  raw         & 0x3f;
  const imm16 = raw & 0xffff;
  i.imm16   = imm16;
  i.imm16s  = (imm16 & 0x8000) ? (imm16 | 0xffff0000) : imm16;
  i.target26 = raw & 0x3ffffff;
}
