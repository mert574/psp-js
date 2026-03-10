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
    case 0x14: return execBEQL(cpu, i);  // BEQL (branch-likely)
    case 0x15: return execBNEL(cpu, i);  // BNEL
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
    case 0x33: break; // PREF — NOP
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

function execLWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = (addr & 3);
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  // LWL loads the high bytes
  const mask = (0xFFFFFFFF >>> ((3 - shift) * 8)) >>> 0;
  cpu.regs.setGpr(i.rt, (reg & mask) | (mem << (shift * 8)));
}

function execLWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = (addr & 3);
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  // LWR loads the low bytes
  const mask = (0xFFFFFFFF << ((shift + 1) * 8)) >>> 0;
  cpu.regs.setGpr(i.rt, (reg & mask) | (mem >>> ((3 - shift) * 8)));
}

function execSWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = (addr & 3);
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  const mask = (0xFFFFFFFF >>> ((3 - shift) * 8)) >>> 0;
  cpu.bus.writeU32(aligned, (mem & mask) | (reg >>> (shift * 8)));
}

function execSWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const aligned = addr & ~3;
  const shift = (addr & 3);
  const mem = cpu.bus.readU32(aligned);
  const reg = cpu.regs.getGpr(i.rt);
  const mask = (0xFFFFFFFF << ((shift + 1) * 8)) >>> 0;
  cpu.bus.writeU32(aligned, (mem & mask) | (reg << ((3 - shift) * 8)));
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
