import type { AllegrexCPU } from "./cpu.js";
import { SyscallException } from "./cpu.js";
import type { Instruction } from "./instruction.js";

/**
 * executeInstruction
 *
 * Dispatches a decoded MIPS instruction to the correct handler.
 *
 * Opcode map (primary opcode, bits 31-26):
 *   0x00  SPECIAL  — R-format arithmetic/logic/shift/jump; see funct field
 *   0x01  REGIMM   — branch-on-reg instructions; see rt field
 *   0x02  J
 *   0x03  JAL
 *   0x04  BEQ
 *   0x05  BNE
 *   0x06  BLEZ
 *   0x07  BGTZ
 *   0x08  ADDI
 *   0x09  ADDIU
 *   0x0A  SLTI
 *   0x0B  SLTIU
 *   0x0C  ANDI
 *   0x0D  ORI
 *   0x0E  XORI
 *   0x0F  LUI
 *   0x20  LB
 *   0x21  LH
 *   0x23  LW
 *   0x24  LBU
 *   0x25  LHU
 *   0x28  SB
 *   0x29  SH
 *   0x2B  SW
 *   0x1C  SPECIAL2 — Allegrex extensions (MADD, MSUB, CLZ, …)
 *   0x1F  SPECIAL3 — Allegrex extensions (EXT, INS, …)
 */
export function executeInstruction(cpu: AllegrexCPU, i: Instruction): void {
  switch (i.op) {
    case 0x00: return execSPECIAL(cpu, i);
    case 0x01: return execREGIMM(cpu, i);
    case 0x02: return execJ(cpu, i);
    case 0x03: return execJAL(cpu, i);
    case 0x04: return execBEQ(cpu, i);
    case 0x05: return execBNE(cpu, i);
    case 0x06: return execBLEZ(cpu, i);
    case 0x07: return execBGTZ(cpu, i);
    case 0x08: return execADDI(cpu, i);
    case 0x09: return execADDIU(cpu, i);
    case 0x0a: return execSLTI(cpu, i);
    case 0x0b: return execSLTIU(cpu, i);
    case 0x0c: return execANDI(cpu, i);
    case 0x0d: return execORI(cpu, i);
    case 0x0e: return execXORI(cpu, i);
    case 0x0f: return execLUI(cpu, i);
    case 0x10: return execCOP0(cpu, i);
    case 0x11: return execCOP1(cpu, i);  // COP1 (FPU)
    case 0x12: return execCOP2(cpu, i);  // COP2 (VFPU computational)
    case 0x14: return execBEQL(cpu, i);  // BEQL (branch-likely)
    case 0x15: return execBNEL(cpu, i);  // BNEL
    case 0x1c: return execSPECIAL2(cpu, i);
    case 0x18: return execVFPUPrefix(cpu, i); // VFPU prefix (VPFXS/VPFXT)
    case 0x19: return execVFPU0(cpu, i);     // VFPU0 (vadd, vsub, vdiv, etc.)
    case 0x1b: return execVFPUPrefix(cpu, i); // VPFXD
    case 0x1f: return execSPECIAL3(cpu, i);
    case 0x16: return execBLEZL(cpu, i); // BLEZL
    case 0x17: return execBGTZL(cpu, i); // BGTZL
    case 0x20: return execLB(cpu, i);
    case 0x21: return execLH(cpu, i);
    case 0x22: return execLWL(cpu, i);
    case 0x23: return execLW(cpu, i);
    case 0x24: return execLBU(cpu, i);
    case 0x25: return execLHU(cpu, i);
    case 0x26: return execLWR(cpu, i);
    case 0x28: return execSB(cpu, i);
    case 0x29: return execSH(cpu, i);
    case 0x2a: return execSWL(cpu, i);
    case 0x2b: return execSW(cpu, i);
    case 0x2e: return execSWR(cpu, i);
    case 0x2f: break; // CACHE — NOP
    case 0x30: return execLL(cpu, i);    // LL (Load Linked)
    case 0x32: return execLVS(cpu, i);   // LV.S (Load VFPU Single)
    case 0x38: return execSC(cpu, i);    // SC (Store Conditional)
    case 0x3a: return execSVS(cpu, i);   // SV.S (Store VFPU Single)
    case 0x31: return execLWC1(cpu, i);  // LWC1 — load word to FPR
    case 0x33: break; // PREF — NOP
    case 0x34: return execLVQ(cpu, i);   // LV.Q (Load VFPU Quad)
    case 0x35: return execLVQ(cpu, i);   // LV.Q (alternate encoding)
    case 0x36: return execVFPUPrefix(cpu, i); // VFPU5 (vpfxs/vpfxt/vpfxd/viim/vfim)
    case 0x37: return execSVQ(cpu, i);   // SV.Q (alternate encoding)
    case 0x39: return execSWC1(cpu, i);  // SWC1 — store word from FPR
    case 0x3c: return execSVQ(cpu, i);   // SV.Q (Store VFPU Quad)
    case 0x3d: return execVFPU6(cpu, i); // VFPU6 (vmmul, vmscl, etc.)
    case 0x3e: return execSVQ(cpu, i);   // SV (SVL.Q/SVR.Q — unaligned quad store)
    default:
      throw new Error(`Unimplemented opcode 0x${i.op.toString(16)} at 0x${i.pc.toString(16)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Schedule a branch: the next instruction runs in the delay slot, then we jump. */
function branch(cpu: AllegrexCPU, i: Instruction, taken: boolean): void {
  if (taken) {
    const target = (i.pc + 4) + (i.imm16s << 2);
    cpu.inDelaySlot     = true;
    cpu.delaySlotTarget = target >>> 0;
  }
}

function branchLikely(cpu: AllegrexCPU, i: Instruction, taken: boolean): void {
  if (taken) {
    branch(cpu, i, true);
  } else {
    // Branch-likely: skip the delay slot when not taken.
    cpu.regs.pc = (cpu.regs.pc + 4) >>> 0;
  }
}

// ── SPECIAL (op=0x00) ─────────────────────────────────────────────────────────

function execSPECIAL(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  switch (i.funct) {
    // Shifts
    case 0x00: // SLL  rd, rt, shamt
      r.setGpr(i.rd, r.getGpr(i.rt) << i.shamt);
      break;
    case 0x02: // SRL  rd, rt, shamt
      r.setGpr(i.rd, r.getGpr(i.rt) >>> i.shamt);
      break;
    case 0x03: // SRA  rd, rt, shamt
      r.setGpr(i.rd, (r.getGpr(i.rt) | 0) >> i.shamt);
      break;
    case 0x04: // SLLV rd, rt, rs
      r.setGpr(i.rd, r.getGpr(i.rt) << (r.getGpr(i.rs) & 0x1f));
      break;
    case 0x06: // SRLV rd, rt, rs
      r.setGpr(i.rd, r.getGpr(i.rt) >>> (r.getGpr(i.rs) & 0x1f));
      break;
    case 0x07: // SRAV rd, rt, rs
      r.setGpr(i.rd, (r.getGpr(i.rt) | 0) >> (r.getGpr(i.rs) & 0x1f));
      break;

    // Jumps
    case 0x08: // JR   rs
      cpu.inDelaySlot     = true;
      cpu.delaySlotTarget = r.getGpr(i.rs);
      break;
    case 0x09: // JALR rd, rs
      r.setGpr(i.rd, (r.pc + 4) >>> 0); // link = PC+8 (after delay slot)
      cpu.inDelaySlot     = true;
      cpu.delaySlotTarget = r.getGpr(i.rs);
      break;

    // Move from/to HI/LO
    case 0x10: r.setGpr(i.rd, r.hi); break;             // MFHI
    case 0x11: r.hi = r.getGpr(i.rs); break;            // MTHI
    case 0x12: r.setGpr(i.rd, r.lo); break;             // MFLO
    case 0x13: r.lo = r.getGpr(i.rs); break;            // MTLO
    case 0x18: {                                         // MULT
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      const result = BigInt(a) * BigInt(b);
      r.lo = Number(result & 0xffffffffn) >>> 0;
      r.hi = Number((result >> 32n) & 0xffffffffn) >>> 0;
      break;
    }
    case 0x19: {                                         // MULTU
      const result = BigInt(r.getGpr(i.rs)) * BigInt(r.getGpr(i.rt));
      r.lo = Number(result & 0xffffffffn) >>> 0;
      r.hi = Number((result >> 32n) & 0xffffffffn) >>> 0;
      break;
    }
    case 0x1a: {                                         // DIV
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      if (b !== 0) { r.lo = (a / b) | 0; r.hi = (a % b) | 0; }
      break;
    }
    case 0x1b: {                                         // DIVU
      const a = r.getGpr(i.rs) >>> 0;
      const b = r.getGpr(i.rt) >>> 0;
      if (b !== 0) { r.lo = (a / b) >>> 0; r.hi = (a % b) >>> 0; }
      break;
    }

    // ALU
    case 0x20: // ADD  (we ignore overflow trap)
    case 0x21: // ADDU
      r.setGpr(i.rd, r.getGpr(i.rs) + r.getGpr(i.rt));
      break;
    case 0x22: // SUB  (ignore overflow)
    case 0x23: // SUBU
      r.setGpr(i.rd, r.getGpr(i.rs) - r.getGpr(i.rt));
      break;
    case 0x24: // AND
      r.setGpr(i.rd, r.getGpr(i.rs) & r.getGpr(i.rt));
      break;
    case 0x25: // OR
      r.setGpr(i.rd, r.getGpr(i.rs) | r.getGpr(i.rt));
      break;
    case 0x26: // XOR
      r.setGpr(i.rd, r.getGpr(i.rs) ^ r.getGpr(i.rt));
      break;
    case 0x27: // NOR
      r.setGpr(i.rd, ~(r.getGpr(i.rs) | r.getGpr(i.rt)));
      break;
    case 0x2a: // SLT
      r.setGpr(i.rd, (r.getGpr(i.rs) | 0) < (r.getGpr(i.rt) | 0) ? 1 : 0);
      break;
    case 0x2b: // SLTU
      r.setGpr(i.rd, r.getGpr(i.rs) < r.getGpr(i.rt) ? 1 : 0);
      break;
    case 0x2d: // DADDU — on 32-bit Allegrex, same as ADDU
      r.setGpr(i.rd, r.getGpr(i.rs) + r.getGpr(i.rt));
      break;

    // Conditional moves
    case 0x0a: // MOVZ rd, rs, rt — if rt==0 then rd=rs
      if (r.getGpr(i.rt) === 0) r.setGpr(i.rd, r.getGpr(i.rs));
      break;
    case 0x0b: // MOVN rd, rs, rt — if rt!=0 then rd=rs
      if (r.getGpr(i.rt) !== 0) r.setGpr(i.rd, r.getGpr(i.rs));
      break;

    // Syscall / break
    case 0x0c: // SYSCALL — dispatch to HLE kernel
      throw new SyscallException((i.raw >>> 6) & 0xfffff);
    case 0x0d: // BREAK
      throw new Error(`BREAK at 0x${i.pc.toString(16)}`);
    case 0x0f: // SYNC — memory barrier (NOP for us)
      break;

    // Allegrex extensions
    case 0x16: { // MAX rd, rs, rt — signed max
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      r.setGpr(i.rd, a >= b ? a : b);
      break;
    }
    case 0x17: { // MIN rd, rs, rt — signed min
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      r.setGpr(i.rd, a <= b ? a : b);
      break;
    }

    default:
      throw new Error(`Unimplemented SPECIAL funct=0x${i.funct.toString(16)} at 0x${i.pc.toString(16)}`);
  }
}

// ── REGIMM (op=0x01) ─────────────────────────────────────────────────────────

function execREGIMM(cpu: AllegrexCPU, i: Instruction): void {
  const rs = (cpu.regs.getGpr(i.rs) | 0);
  switch (i.rt) {
    case 0x00: branch(cpu, i, rs <  0); break; // BLTZ
    case 0x01: branch(cpu, i, rs >= 0); break; // BGEZ
    case 0x02: branchLikely(cpu, i, rs <  0); break; // BLTZL
    case 0x03: branchLikely(cpu, i, rs >= 0); break; // BGEZL
    case 0x10: // BLTZAL
      cpu.regs.setGpr(31, (cpu.regs.pc + 4) >>> 0); // link = PC+8
      branch(cpu, i, rs < 0);
      break;
    case 0x11: // BGEZAL
      cpu.regs.setGpr(31, (cpu.regs.pc + 4) >>> 0); // link = PC+8
      branch(cpu, i, rs >= 0);
      break;
    default:
      throw new Error(`Unimplemented REGIMM rt=0x${i.rt.toString(16)} at 0x${i.pc.toString(16)}`);
  }
}

// ── J-format branches ─────────────────────────────────────────────────────────

function execJ(cpu: AllegrexCPU, i: Instruction): void {
  const target = ((i.pc + 4) & 0xf0000000) | (i.target26 << 2);
  cpu.inDelaySlot     = true;
  cpu.delaySlotTarget = target >>> 0;
}

function execJAL(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(31, (cpu.regs.pc + 4) >>> 0); // link = PC+8 (after delay slot)
  execJ(cpu, i);
}

// ── I-format conditional branches ────────────────────────────────────────────

function execBEQ(cpu: AllegrexCPU, i: Instruction): void {
  branch(cpu, i, cpu.regs.getGpr(i.rs) === cpu.regs.getGpr(i.rt));
}
function execBNE(cpu: AllegrexCPU, i: Instruction): void {
  branch(cpu, i, cpu.regs.getGpr(i.rs) !== cpu.regs.getGpr(i.rt));
}
function execBLEZ(cpu: AllegrexCPU, i: Instruction): void {
  branch(cpu, i, (cpu.regs.getGpr(i.rs) | 0) <= 0);
}
function execBGTZ(cpu: AllegrexCPU, i: Instruction): void {
  branch(cpu, i, (cpu.regs.getGpr(i.rs) | 0) > 0);
}

// ── I-format ALU immediates ───────────────────────────────────────────────────

function execADDI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) + i.imm16s);
}
function execADDIU(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) + i.imm16s);
}
function execSLTI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, (cpu.regs.getGpr(i.rs) | 0) < i.imm16s ? 1 : 0);
}
function execSLTIU(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) < (i.imm16s >>> 0) ? 1 : 0);
}
function execANDI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) & i.imm16);
}
function execORI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) | i.imm16);
}
function execXORI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.regs.getGpr(i.rs) ^ i.imm16);
}
function execLUI(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, i.imm16 << 16);
}

// ── Load / store ──────────────────────────────────────────────────────────────

function ea(cpu: AllegrexCPU, i: Instruction): number {
  return (cpu.regs.getGpr(i.rs) + i.imm16s) >>> 0;
}

function execLB(cpu: AllegrexCPU, i: Instruction): void {
  const v = cpu.bus.readU8(ea(cpu, i));
  cpu.regs.setGpr(i.rt, v & 0x80 ? (v | 0xffffff00) : v);
}
function execLH(cpu: AllegrexCPU, i: Instruction): void {
  const v = cpu.bus.readU16(ea(cpu, i));
  cpu.regs.setGpr(i.rt, v & 0x8000 ? (v | 0xffff0000) : v);
}
function execLW(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.bus.readU32(ea(cpu, i)));
}
function execLBU(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.bus.readU8(ea(cpu, i)));
}
function execLHU(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.bus.readU16(ea(cpu, i)));
}
function execSB(cpu: AllegrexCPU, i: Instruction): void {
  cpu.bus.writeU8(ea(cpu, i), cpu.regs.getGpr(i.rt));
}
function execSH(cpu: AllegrexCPU, i: Instruction): void {
  cpu.bus.writeU16(ea(cpu, i), cpu.regs.getGpr(i.rt));
}
function execSW(cpu: AllegrexCPU, i: Instruction): void {
  cpu.bus.writeU32(ea(cpu, i), cpu.regs.getGpr(i.rt));
}

// ── Unaligned load/store ───────────────────────────────────────────────────

// Unaligned load/store tables for MIPS little-endian.
// LWL/LWR/SWL/SWR byte-shift behavior is notoriously tricky.
// Using explicit lookup tables from the MIPS Architecture Reference Manual.

// LWL: load bytes from mem[addr..aligned] into HIGH part of register
//   shift=0: reg = (reg & 0x00FFFFFF) | (mem << 24)
//   shift=1: reg = (reg & 0x0000FFFF) | (mem << 16)
//   shift=2: reg = (reg & 0x000000FF) | (mem << 8)
//   shift=3: reg = mem
const LWL_MASK  = [0x00FFFFFF, 0x0000FFFF, 0x000000FF, 0x00000000] as const;
const LWL_SHIFT = [24, 16, 8, 0] as const;

function execLWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = addr & 3;
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.regs.setGpr(i.rt, ((reg & LWL_MASK[shift]!) | (mem << LWL_SHIFT[shift]!)) >>> 0);
}

// LWR: load bytes from mem[addr..aligned+3] into LOW part of register
//   shift=0: reg = mem
//   shift=1: reg = (reg & 0xFF000000) | (mem >>> 8)
//   shift=2: reg = (reg & 0xFFFF0000) | (mem >>> 16)
//   shift=3: reg = (reg & 0xFFFFFF00) | (mem >>> 24)
const LWR_MASK  = [0x00000000, 0xFF000000, 0xFFFF0000, 0xFFFFFF00] as const;
const LWR_SHIFT = [0, 8, 16, 24] as const;

function execLWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = addr & 3;
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.regs.setGpr(i.rt, ((reg & LWR_MASK[shift]!) | (mem >>> LWR_SHIFT[shift]!)) >>> 0);
}

// SWL: store HIGH bytes of register into mem[addr..aligned]
//   shift=0: mem = (mem & 0xFFFFFF00) | (reg >>> 24)
//   shift=1: mem = (mem & 0xFFFF0000) | (reg >>> 16)
//   shift=2: mem = (mem & 0xFF000000) | (reg >>> 8)
//   shift=3: mem = reg
const SWL_MASK  = [0xFFFFFF00, 0xFFFF0000, 0xFF000000, 0x00000000] as const;
const SWL_SHIFT = [24, 16, 8, 0] as const;

function execSWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = addr & 3;
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.bus.writeU32(aligned, ((mem & SWL_MASK[shift]!) | (reg >>> SWL_SHIFT[shift]!)) >>> 0);
}

// SWR: store LOW bytes of register into mem[addr..aligned+3]
//   shift=0: mem = reg
//   shift=1: mem = (mem & 0x000000FF) | (reg << 8)
//   shift=2: mem = (mem & 0x0000FFFF) | (reg << 16)
//   shift=3: mem = (mem & 0x00FFFFFF) | (reg << 24)
const SWR_MASK  = [0x00000000, 0x000000FF, 0x0000FFFF, 0x00FFFFFF] as const;
const SWR_SHIFT = [0, 8, 16, 24] as const;

function execSWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = addr & 3;
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.bus.writeU32(aligned, ((mem & SWR_MASK[shift]!) | (reg << SWR_SHIFT[shift]!)) >>> 0);
}

// ── COP0 — Coprocessor 0 (system control) ─────────────────────────────────

function execCOP0(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  switch (i.rs) {
    case 0x00: // MFC0 rt, rd — move from CP0 register
      switch (i.rd) {
        case 12: r.setGpr(i.rt, r.cp0Status); break;
        case 13: r.setGpr(i.rt, r.cp0Cause); break;
        case 14: r.setGpr(i.rt, r.cp0EPC); break;
        default: r.setGpr(i.rt, 0); break; // unhandled CP0 reg
      }
      break;
    case 0x04: // MTC0 rt, rd — move to CP0 register
      switch (i.rd) {
        case 12: r.cp0Status = r.getGpr(i.rt); break;
        case 13: r.cp0Cause = r.getGpr(i.rt); break;
        case 14: r.cp0EPC = r.getGpr(i.rt); break;
        default: break; // ignore
      }
      break;
    case 0x10: // COP0 function — ERET, etc.
      if ((i.funct & 0x3f) === 0x18) { // ERET
        r.pc = r.cp0EPC;
      }
      break;
    default:
      break; // ignore unknown COP0 sub-ops
  }
}

// ── Branch-likely variants ─────────────────────────────────────────────────

function execBEQL(cpu: AllegrexCPU, i: Instruction): void {
  branchLikely(cpu, i, cpu.regs.getGpr(i.rs) === cpu.regs.getGpr(i.rt));
}
function execBNEL(cpu: AllegrexCPU, i: Instruction): void {
  branchLikely(cpu, i, cpu.regs.getGpr(i.rs) !== cpu.regs.getGpr(i.rt));
}
function execBLEZL(cpu: AllegrexCPU, i: Instruction): void {
  branchLikely(cpu, i, (cpu.regs.getGpr(i.rs) | 0) <= 0);
}
function execBGTZL(cpu: AllegrexCPU, i: Instruction): void {
  branchLikely(cpu, i, (cpu.regs.getGpr(i.rs) | 0) > 0);
}

// ── SPECIAL2 — Allegrex extensions (MADD, MSUB, CLZ, …) ─────────────────

function execSPECIAL2(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  switch (i.funct) {
    case 0x00: { // MADD — multiply-add to hi/lo
      const result = BigInt(r.getGpr(i.rs) | 0) * BigInt(r.getGpr(i.rt) | 0) +
                     (BigInt(r.hi | 0) * 0x100000000n + BigInt(r.lo >>> 0));
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x01: { // MADDU — multiply-add unsigned
      const result = BigInt(r.getGpr(i.rs) >>> 0) * BigInt(r.getGpr(i.rt) >>> 0) +
                     (BigInt(r.hi >>> 0) * 0x100000000n + BigInt(r.lo >>> 0));
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x04: { // MSUB — multiply-subtract from hi/lo
      const result = (BigInt(r.hi | 0) * 0x100000000n + BigInt(r.lo >>> 0)) -
                     BigInt(r.getGpr(i.rs) | 0) * BigInt(r.getGpr(i.rt) | 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x05: { // MSUBU — multiply-subtract unsigned
      const result = (BigInt(r.hi >>> 0) * 0x100000000n + BigInt(r.lo >>> 0)) -
                     BigInt(r.getGpr(i.rs) >>> 0) * BigInt(r.getGpr(i.rt) >>> 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x20: { // CLZ — count leading zeros
      const v = r.getGpr(i.rs);
      r.setGpr(i.rd, v === 0 ? 32 : Math.clz32(v));
      break;
    }
    case 0x21: { // CLO — count leading ones
      const v = r.getGpr(i.rs) ^ 0xFFFFFFFF;
      r.setGpr(i.rd, v === 0 ? 32 : Math.clz32(v));
      break;
    }
    default:
      break;
  }
}

// ── SPECIAL3 — Allegrex extensions (EXT, INS, …) ────────────────────────

function execSPECIAL3(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  switch (i.funct) {
    case 0x00: { // EXT — extract bit field: rd = (rs >> shamt) & ((1 << (rd+1)) - 1)
      // EXT rt, rs, pos, size: pos=shamt, size=rd+1
      const pos = i.shamt;
      const size = i.rd + 1;
      const mask = size >= 32 ? 0xFFFFFFFF : ((1 << size) - 1);
      r.setGpr(i.rt, (r.getGpr(i.rs) >>> pos) & mask);
      break;
    }
    case 0x04: { // INS — insert bit field
      // INS rt, rs, pos, size: pos=shamt, size=rd+1-shamt
      const pos = i.shamt;
      const size = i.rd + 1 - pos;
      const mask = size >= 32 ? 0xFFFFFFFF : ((1 << size) - 1);
      const cleared = r.getGpr(i.rt) & ~(mask << pos);
      const inserted = (r.getGpr(i.rs) & mask) << pos;
      r.setGpr(i.rt, (cleared | inserted) >>> 0);
      break;
    }
    case 0x3b: { // RDHWR — read hardware register
      // Used for TLS on MIPS
      const hwreg = i.rd;
      if (hwreg === 29) {
        // ULR (User Local Register) — often used for TLS pointer
        r.setGpr(i.rt, r.getGpr(26)); // Use $k0 as TLS base
      } else {
        r.setGpr(i.rt, 0);
      }
      break;
    }
    default:
      break;
  }
}

// ── COP1 — Coprocessor 1 (FPU) ──────────────────────────────────────────

function execCOP1(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  const fmt = i.rs; // bits 25-21 = sub-opcode / format
  const ft = i.rt;  // bits 20-16
  const fs = i.rd;  // bits 15-11
  const fd = i.shamt; // bits 10-6

  switch (fmt) {
    case 0x00: // MFC1 rt, fs — move from FPR to GPR (raw bits)
      r.setGpr(ft, r.getFprBits(fs));
      break;
    case 0x02: // CFC1 rt, fs — move from FPU control register
      if (fs === 31) r.setGpr(ft, r.fcr31);
      else r.setGpr(ft, 0);
      break;
    case 0x04: // MTC1 rt, fs — move from GPR to FPR (raw bits)
      r.setFprBits(fs, r.getGpr(ft));
      break;
    case 0x06: // CTC1 rt, fs — move to FPU control register
      if (fs === 31) r.fcr31 = r.getGpr(ft);
      break;
    case 0x08: { // BC1 — branch on FPU condition
      const cc = (r.fcr31 >>> 23) & 1; // condition bit
      const nd = (ft >>> 1) & 1; // nullify delay (likely)
      const tf = ft & 1; // true/false
      const taken = tf ? cc === 1 : cc === 0;
      if (nd) {
        branchLikely(cpu, i, taken);
      } else {
        branch(cpu, i, taken);
      }
      break;
    }
    case 0x10: // S format (single-precision float)
      execCOP1_S(cpu, i, fs, ft, fd);
      break;
    case 0x14: // W format (word — integer in FPR)
      execCOP1_W(cpu, i, fs, fd);
      break;
    default:
      // Ignore unknown COP1 sub-formats
      break;
  }
}

function execCOP1_S(cpu: AllegrexCPU, i: Instruction, fs: number, ft: number, fd: number): void {
  const r = cpu.regs;
  const s = r.getFpr(fs);
  const t = r.getFpr(ft);

  switch (i.funct) {
    case 0x00: r.setFpr(fd, s + t); break;    // ADD.S
    case 0x01: r.setFpr(fd, s - t); break;    // SUB.S
    case 0x02: r.setFpr(fd, s * t); break;    // MUL.S
    case 0x03: r.setFpr(fd, s / t); break;    // DIV.S
    case 0x04: r.setFpr(fd, Math.sqrt(s)); break; // SQRT.S
    case 0x05: r.setFpr(fd, Math.abs(s)); break;  // ABS.S
    case 0x06: r.setFpr(fd, s); break;        // MOV.S
    case 0x07: r.setFpr(fd, -s); break;       // NEG.S
    case 0x0c: // ROUND.W.S
      r.setFprBits(fd, (Math.round(s) | 0) >>> 0);
      break;
    case 0x0d: // TRUNC.W.S
      r.setFprBits(fd, (Math.trunc(s) | 0) >>> 0);
      break;
    case 0x0e: // CEIL.W.S
      r.setFprBits(fd, (Math.ceil(s) | 0) >>> 0);
      break;
    case 0x0f: // FLOOR.W.S
      r.setFprBits(fd, (Math.floor(s) | 0) >>> 0);
      break;
    case 0x24: // CVT.W.S — convert float to integer (stored in FPR)
      r.setFprBits(fd, (Math.trunc(s) | 0) >>> 0);
      break;
    default: {
      // C.cond.S comparison instructions (funct 0x30-0x3F)
      if (i.funct >= 0x30 && i.funct <= 0x3f) {
        const cond = i.funct & 0x0f;
        let result = false;
        const unordered = isNaN(s) || isNaN(t);
        if (cond & 1) result = result || unordered;         // UN
        if (cond & 2) result = result || (s === t);         // EQ
        if (cond & 4) result = result || (s < t);           // LT
        // Set condition bit in FCSR
        if (result) r.fcr31 |= (1 << 23);
        else r.fcr31 &= ~(1 << 23);
      }
      break;
    }
  }
}

function execCOP1_W(cpu: AllegrexCPU, _i: Instruction, fs: number, fd: number): void {
  const r = cpu.regs;
  switch (_i.funct) {
    case 0x20: { // CVT.S.W — convert integer (in FPR) to single float
      const intVal = r.getFprBits(fs) | 0; // signed
      r.setFpr(fd, intVal);
      break;
    }
    default:
      break;
  }
}

// ── LWC1 / SWC1 — Load/Store FPR ──────────────────────────────────────

function execLWC1(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  cpu.regs.setFprBits(i.rt, cpu.bus.readU32(addr));
}

function execSWC1(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  cpu.bus.writeU32(addr, cpu.regs.getFprBits(i.rt));
}

// ── LL / SC — Load Linked / Store Conditional ──────────────────────────
// In single-threaded emulation, LL=LW and SC=SW+set_rt_1

function execLL(cpu: AllegrexCPU, i: Instruction): void {
  cpu.regs.setGpr(i.rt, cpu.bus.readU32(ea(cpu, i)));
}

function execSC(cpu: AllegrexCPU, i: Instruction): void {
  cpu.bus.writeU32(ea(cpu, i), cpu.regs.getGpr(i.rt));
  cpu.regs.setGpr(i.rt, 1); // always succeeds
}

// ── VFPU ────────────────────────────────────────────────────────────────

function vfpuRegIndex(i: Instruction): number {
  // For LV.S and SV.S, the VFPU register is encoded as:
  // vt[4:0] = i.rt (bits 20-16)
  // vt[6:5] = bits 1:0 of the raw instruction
  const vt = i.rt | ((i.raw & 3) << 5);
  return vt;
}

function execLVS(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const vt = vfpuRegIndex(i);
  const bits = cpu.bus.readU32(addr);
  const view = new DataView(cpu.regs.vfpr.buffer);
  view.setUint32(vt * 4, bits, true);
}

function execSVS(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const vt = vfpuRegIndex(i);
  const view = new DataView(cpu.regs.vfpr.buffer);
  const bits = view.getUint32(vt * 4, true);
  cpu.bus.writeU32(addr, bits);
}

// LV.Q — Load VFPU Quad (4 consecutive floats)
// Encoding: opcode=0x34, base=rs, vt(quad)=rt + extra bits, offset=imm14*4
function execLVQ(cpu: AllegrexCPU, i: Instruction): void {
  // Offset is imm16 but the bottom 2 bits encode the upper vt bits
  const offset = i.imm16s & ~3; // 14-bit offset, word-aligned
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  // vt quad register: bits [20:16] = low 5 bits, bits [1:0] of raw = high 2 bits
  const vt = (i.rt | ((i.raw & 1) << 5)) & 0x1F; // quad index (0-31 quads)
  // Quad register maps to 4 consecutive VFPU registers: vt*4, vt*4+1, vt*4+2, vt*4+3
  // Actually VFPU quad addressing is column/row based. Simplified: use vt * 4 as base
  const base = (vt & 0x1F) * 4; // simplified quad addressing
  const view = new DataView(cpu.regs.vfpr.buffer);
  for (let j = 0; j < 4; j++) {
    const bits = cpu.bus.readU32((addr + j * 4) >>> 0);
    if (base + j < 128) {
      view.setUint32((base + j) * 4, bits, true);
    }
  }
}

// SV.Q — Store VFPU Quad
function execSVQ(cpu: AllegrexCPU, i: Instruction): void {
  const offset = i.imm16s & ~3;
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  const vt = (i.rt | ((i.raw & 1) << 5)) & 0x1F;
  const base = (vt & 0x1F) * 4;
  const view = new DataView(cpu.regs.vfpr.buffer);
  for (let j = 0; j < 4; j++) {
    if (base + j < 128) {
      const bits = view.getUint32((base + j) * 4, true);
      cpu.bus.writeU32((addr + j * 4) >>> 0, bits);
    }
  }
}

function execVFPUPrefix(_cpu: AllegrexCPU, i: Instruction): void {
  const r = _cpu.regs;
  const data = i.raw & 0x000FFFFF;
  const subop = (i.raw >>> 24) & 0x3;
  switch (subop) {
    case 0: // VPFXS
      r.vpfxs = data;
      r.vpfxsEnabled = true;
      break;
    case 1: // VPFXT
      r.vpfxt = data;
      r.vpfxtEnabled = true;
      break;
    case 3: // VPFXD
      r.vpfxd = data;
      r.vpfxdEnabled = true;
      break;
  }
}

// COP2 — VFPU computational instructions
function execCOP2(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  const fmt = i.rs; // bits 25-21

  switch (fmt) {
    case 0x03: { // MFVC — move from VFPU control reg to GPR
      const vcreg = (i.raw >>> 8) & 0x7F;
      if (vcreg < 16) {
        r.setGpr(i.rt, r.vfpuCtrl[vcreg]!);
      } else if (vcreg === 128) { // VFPU_CC
        r.setGpr(i.rt, r.vfpuCc);
      } else {
        r.setGpr(i.rt, 0);
      }
      break;
    }
    case 0x07: { // MTVC — move from GPR to VFPU control reg
      const vcreg = (i.raw >>> 8) & 0x7F;
      if (vcreg < 16) {
        r.vfpuCtrl[vcreg] = r.getGpr(i.rt);
      } else if (vcreg === 128) {
        r.vfpuCc = r.getGpr(i.rt);
      }
      break;
    }
    case 0x00: { // MFV — move from VFPU register to GPR
      const vs = (i.raw >>> 8) & 0x7F;
      const view = new DataView(r.vfpr.buffer);
      r.setGpr(i.rt, view.getUint32(vs * 4, true));
      break;
    }
    case 0x04: { // MTV — move from GPR to VFPU register
      const vs = (i.raw >>> 8) & 0x7F;
      const view = new DataView(r.vfpr.buffer);
      view.setUint32(vs * 4, r.getGpr(i.rt), true);
      break;
    }
    default:
      // Many VFPU ops — NOP unknown ones for now
      break;
  }

  // Clear prefixes after each VFPU op
  r.vpfxsEnabled = false;
  r.vpfxtEnabled = false;
  r.vpfxdEnabled = false;
}

// VFPU0 — vector arithmetic (vadd, vsub, vsbn, vdiv)
// Stub: NOP unknown ops, clear prefixes
function execVFPU0(cpu: AllegrexCPU, _i: Instruction): void {
  const r = cpu.regs;
  // TODO: implement vadd/vsub/vdiv etc.
  r.vpfxsEnabled = false;
  r.vpfxtEnabled = false;
  r.vpfxdEnabled = false;
}

// VFPU6 — matrix ops (vmmul, vmscl, vrot, etc.)
// Stub: NOP unknown ops, clear prefixes
function execVFPU6(cpu: AllegrexCPU, _i: Instruction): void {
  const r = cpu.regs;
  // TODO: implement vmmul/vmscl/vrot etc.
  r.vpfxsEnabled = false;
  r.vpfxtEnabled = false;
  r.vpfxdEnabled = false;
}
