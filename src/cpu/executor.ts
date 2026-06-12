import type { AllegrexCPU } from "./cpu.js";
import { SyscallException } from "./cpu.js";
import type { Instruction } from "./instruction.js";
import type { AllegrexRegisters } from "./registers.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("CPU");

/** Clamp float-to-int result — matches real PSP hardware behavior. */
function vfpuFloatToInt(v: number): number {
  if (!isFinite(v) || isNaN(v)) return 0x7FFFFFFF; // Inf, -Inf, NaN → INT_MAX
  if (v >= 2147483647) return 0x7FFFFFFF;
  if (v <= -2147483648) return 0x80000000;
  return (v | 0) >>> 0;
}

/** IEEE 754 round-to-nearest-even (banker's rounding). */
function roundToNearestEven(x: number): number {
  const f = Math.floor(x);
  const frac = x - f;
  if (frac > 0.5) return (f + 1) | 0;
  if (frac < 0.5) return f | 0;
  // Exactly 0.5 — round to even
  return (f & 1) ? ((f + 1) | 0) : (f | 0);
}

/** Flush denormal float to zero if FS bit is set (FCR31 bit 24). */
function fpuFlush(v: number, fs: number): number {
  if (fs && v !== 0 && Math.abs(v) < 1.1754944e-38) return 0;
  return v;
}

/**
 * Apply PSP FPU rounding mode to a double-precision result, converting to float.
 * JS always uses round-to-nearest-even. For other modes, adjust the result.
 * fcr31 bits [1:0]: 0=nearest, 1=toward zero, 2=toward +inf, 3=toward -inf
 */
const _froundBuf = new Float32Array(1);
const _froundU32 = new Uint32Array(_froundBuf.buffer);
function fpuRound(d: number, rm: number): number {
  if (rm === 0 || !isFinite(d)) return Math.fround(d); // default: nearest-even
  const f = Math.fround(d); // nearest-even result
  if (f === d) return f;     // exact — no rounding needed
  if (rm === 1) {
    // Toward zero: if fround rounded AWAY from zero, step back 1 ULP
    if ((d > 0 && f > d) || (d < 0 && f < d)) {
      _froundBuf[0] = f;
      _froundU32[0] = (_froundU32[0]! - 1) >>> 0;
      return _froundBuf[0]!;
    }
    return f;
  }
  if (rm === 2) {
    // Toward +inf: if fround rounded down, step up 1 ULP
    if (f < d) {
      _froundBuf[0] = f;
      if (d > 0) _froundU32[0] = (_froundU32[0]! + 1) >>> 0;
      else _froundU32[0] = (_froundU32[0]! - 1) >>> 0;
      return _froundBuf[0]!;
    }
    return f;
  }
  // rm === 3: toward -inf: if fround rounded up, step down 1 ULP
  if (f > d) {
    _froundBuf[0] = f;
    if (d > 0) _froundU32[0] = (_froundU32[0]! - 1) >>> 0;
    else _froundU32[0] = (_froundU32[0]! + 1) >>> 0;
    return _froundBuf[0]!;
  }
  return f;
}

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
    case 0x18: return execVFPU0(cpu, i);      // VFPU0: vadd, vsub, vsbn, vdiv
    case 0x19: return execVFPU1(cpu, i);      // VFPU1: vmul, vdot, vscl, vhdp, vcrs, vdet
    case 0x1b: return execVFPU3(cpu, i);      // VFPU3: vcmp, vmin, vmax, vsge, vslt
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
    case 0x31: return execLWC1(cpu, i);  // LWC1 — load word to FPR
    case 0x32: return execLVS(cpu, i);   // LV.S (Load VFPU Single)
    case 0x33: break;                    // INVALID/PREF — NOP
    case 0x34: return execVFPU4Jump(cpu, i); // VFPU4Jump
    case 0x35: return execLV(cpu, i);    // LV (unaligned quad load)
    case 0x36: return execLVQ(cpu, i);   // LV.Q (aligned quad load)
    case 0x37: return execVFPU5(cpu, i); // VFPU5: vpfxs, vpfxt, vpfxd, viim, vfim
    case 0x38: return execSC(cpu, i);    // SC (Store Conditional)
    case 0x39: return execSWC1(cpu, i);  // SWC1 — store word from FPR
    case 0x3a: return execSVS(cpu, i);   // SV.S (Store VFPU Single)
    case 0x3b: break;                    // INVALID — NOP
    case 0x3c: return execVFPU6(cpu, i); // VFPU6: vmmul, vtfm, vmscl, vcrsp, vqmul, vrot
    case 0x3d: return execSV(cpu, i);    // SV (unaligned quad store)
    case 0x3e: return execSVQ(cpu, i);   // SV.Q (aligned quad store)
    case 0x3f: break;                    // vflush — NOP
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
    case 0x02: { // SRL / ROTR  rd, rt, shamt
      const val = r.getGpr(i.rt) >>> 0;
      const sa = i.shamt;
      if (i.rs & 1) { // ROTR
        r.setGpr(i.rd, ((val >>> sa) | (val << (32 - sa))) >>> 0);
      } else { // SRL
        r.setGpr(i.rd, val >>> sa);
      }
      break;
    }
    case 0x03: // SRA  rd, rt, shamt
      r.setGpr(i.rd, (r.getGpr(i.rt) | 0) >> i.shamt);
      break;
    case 0x04: // SLLV rd, rt, rs
      r.setGpr(i.rd, r.getGpr(i.rt) << (r.getGpr(i.rs) & 0x1f));
      break;
    case 0x06: { // SRLV / ROTRV  rd, rt, rs
      const val = r.getGpr(i.rt) >>> 0;
      const sa = r.getGpr(i.rs) & 0x1f;
      if (i.shamt & 1) { // ROTRV
        r.setGpr(i.rd, ((val >>> sa) | (val << (32 - sa))) >>> 0);
      } else { // SRLV
        r.setGpr(i.rd, val >>> sa);
      }
      break;
    }
    case 0x07: // SRAV rd, rt, rs
      r.setGpr(i.rd, (r.getGpr(i.rt) | 0) >> (r.getGpr(i.rs) & 0x1f));
      break;

    // Jumps
    case 0x08: // JR   rs
      cpu.inDelaySlot     = true;
      cpu.delaySlotTarget = r.getGpr(i.rs);
      break;
    case 0x09: { // JALR rd, rs
      const target = r.getGpr(i.rs); // read target BEFORE writing link (rd may == rs)
      r.setGpr(i.rd, (r.pc + 4) >>> 0); // link = PC+8 (after delay slot)
      cpu.inDelaySlot     = true;
      cpu.delaySlotTarget = target;
      break;
    }

    // Move from/to HI/LO
    case 0x10: r.setGpr(i.rd, r.hi); break;             // MFHI
    case 0x11: r.hi = r.getGpr(i.rs); break;            // MTHI
    case 0x12: r.setGpr(i.rd, r.lo); break;             // MFLO
    case 0x13: r.lo = r.getGpr(i.rs); break;            // MTLO

    // Allegrex: CLZ/CLO live in SPECIAL at funct=0x16/0x17
    case 0x16: { // CLZ — count leading zeros
      const v = r.getGpr(i.rs);
      r.setGpr(i.rd, Math.clz32(v));
      break;
    }
    case 0x17: { // CLO — count leading ones
      r.setGpr(i.rd, Math.clz32(~r.getGpr(i.rs)));
      break;
    }

    case 0x18: {                                         // MULT
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      const result = BigInt(a) * BigInt(b);
      r.lo = Number(result & 0xffffffffn) >>> 0;
      r.hi = Number((result >> 32n) & 0xffffffffn) >>> 0;
      break;
    }
    case 0x19: {                                         // MULTU
      const result = BigInt(r.getGpr(i.rs) >>> 0) * BigInt(r.getGpr(i.rt) >>> 0);
      r.lo = Number(result & 0xffffffffn) >>> 0;
      r.hi = Number((result >> 32n) & 0xffffffffn) >>> 0;
      break;
    }
    case 0x1a: {                                         // DIV
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      if (a === -2147483648 && b === -1) {
        r.lo = -2147483648 >>> 0; r.hi = -1 >>> 0;
      } else if (b !== 0) {
        r.lo = (a / b) | 0; r.hi = (a % b) | 0;
      } else {
        r.lo = (a < 0 ? 1 : -1) >>> 0; r.hi = a >>> 0;
      }
      break;
    }
    case 0x1b: {                                         // DIVU
      const a = r.getGpr(i.rs) >>> 0;
      const b = r.getGpr(i.rt) >>> 0;
      if (b !== 0) {
        r.lo = (a / b) >>> 0; r.hi = (a % b) >>> 0;
      } else {
        r.lo = (a <= 0xFFFF ? 0xFFFF : 0xFFFFFFFF) >>> 0; r.hi = a >>> 0;
      }
      break;
    }

    // Allegrex: MADD/MADDU/MSUB/MSUBU live in SPECIAL at funct=0x1C-0x1D/0x2E-0x2F
    case 0x1c: { // MADD — signed multiply-add to hi/lo
      const origVal = (BigInt(r.hi | 0) << 32n) | BigInt(r.lo >>> 0);
      const result = origVal + BigInt(r.getGpr(i.rs) | 0) * BigInt(r.getGpr(i.rt) | 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x1d: { // MADDU — unsigned multiply-add
      const origVal = (BigInt(r.hi >>> 0) << 32n) | BigInt(r.lo >>> 0);
      const result = origVal + BigInt(r.getGpr(i.rs) >>> 0) * BigInt(r.getGpr(i.rt) >>> 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
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
      r.setGpr(i.rd, (r.getGpr(i.rs) >>> 0) < (r.getGpr(i.rt) >>> 0) ? 1 : 0);
      break;
    case 0x2c: { // MAX rd, rs, rt — signed max (Allegrex)
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      r.setGpr(i.rd, a >= b ? a : b);
      break;
    }
    case 0x2d: { // MIN rd, rs, rt — signed min (Allegrex)
      const a = r.getGpr(i.rs) | 0;
      const b = r.getGpr(i.rt) | 0;
      r.setGpr(i.rd, a <= b ? a : b);
      break;
    }
    case 0x2e: { // MSUB — signed multiply-subtract from hi/lo (Allegrex)
      const origVal = (BigInt(r.hi | 0) << 32n) | BigInt(r.lo >>> 0);
      const result = origVal - BigInt(r.getGpr(i.rs) | 0) * BigInt(r.getGpr(i.rt) | 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x2f: { // MSUBU — unsigned multiply-subtract (Allegrex)
      const origVal = (BigInt(r.hi >>> 0) << 32n) | BigInt(r.lo >>> 0);
      const result = origVal - BigInt(r.getGpr(i.rs) >>> 0) * BigInt(r.getGpr(i.rt) >>> 0);
      r.lo = Number(result & 0xFFFFFFFFn) >>> 0;
      r.hi = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
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
    case 0x0d: { // BREAK — soft exception
      // If a callback handles it (e.g. GE callback trampoline), skip logging
      if (cpu.onBreak && cpu.onBreak(i.pc)) {
        break;
      }
      const breakCode = (i.raw >>> 6) & 0xfffff;
      log.warn(`BREAK 0x${breakCode.toString(16)} at PC=0x${i.pc.toString(16)}`);
      break;
    }
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
    case 0x12: // BLTZALL (likely)
      cpu.regs.setGpr(31, (cpu.regs.pc + 4) >>> 0);
      branchLikely(cpu, i, rs < 0);
      break;
    case 0x13: // BGEZALL (likely)
      cpu.regs.setGpr(31, (cpu.regs.pc + 4) >>> 0);
      branchLikely(cpu, i, rs >= 0);
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
function execLWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const shift = (addr & 3) * 8;
  const mem = cpu.bus.readU32(addr & ~3);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.regs.setGpr(i.rt, ((reg & (0x00ffffff >>> shift)) | (mem << (24 - shift))) >>> 0);
}

function execLWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const shift = (addr & 3) * 8;
  const mem = cpu.bus.readU32(addr & ~3);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.regs.setGpr(i.rt, ((reg & (0xffffff00 << (24 - shift))) | (mem >>> shift)) >>> 0);
}

function execSWL(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const shift = (addr & 3) * 8;
  const mem = cpu.bus.readU32(addr & ~3);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.bus.writeU32(addr & ~3, ((reg >>> (24 - shift)) | (mem & (0xffffff00 << shift))) >>> 0);
}

function execSWR(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ea(cpu, i);
  const shift = (addr & 3) * 8;
  const mem = cpu.bus.readU32(addr & ~3);
  const reg = cpu.regs.getGpr(i.rt);
  cpu.bus.writeU32(addr & ~3, ((reg << shift) | (mem & (0x00ffffff >>> (24 - shift)))) >>> 0);
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

// ── SPECIAL2 (op=0x1C) — PSP-specific interrupt control ──────────────────
// NOTE: MADD/MSUB/CLZ/CLO are in SPECIAL (op=0x00), NOT here.
// SPECIAL2 on PSP only has HALT (0), MFIC (36), MTIC (38).

function execSPECIAL2(_cpu: AllegrexCPU, _i: Instruction): void {
  // HALT / MFIC / MTIC — all treated as NOP in HLE emulation.
  // (MFIC/MTIC are interrupt controller ops; irrelevant without kernel interrupt handling.)
}

// ── SPECIAL3 — Allegrex extensions (EXT, INS, BSHFL/SEB/SEH/WSBH) ───────

function execSPECIAL3(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  switch (i.funct) {
    case 0x00: { // EXT — extract bit field
      // EXT rt, rs, pos, size: pos=shamt (bits 10-6), size=rd+1 (bits 15-11)
      const pos = i.shamt;
      const size = i.rd + 1;
      const mask = size >= 32 ? 0xFFFFFFFF : ((1 << size) - 1);
      r.setGpr(i.rt, (r.getGpr(i.rs) >>> pos) & mask);
      break;
    }
    case 0x04: { // INS — insert bit field
      // INS rt, rs, pos, size: pos=shamt, msb=rd → size=(rd+1)-pos
      const pos = i.shamt;
      const size = (i.rd + 1) - pos;
      const mask = size >= 32 ? 0xFFFFFFFF : ((1 << size) - 1);
      const cleared = r.getGpr(i.rt) & ~(mask << pos);
      const inserted = (r.getGpr(i.rs) & mask) << pos;
      r.setGpr(i.rt, (cleared | inserted) >>> 0);
      break;
    }
    case 0x18: // ALLEGREX0 sub-encoding (funct=0x18)
    case 0x20: { // ALLEGREX0 sub-encoding (funct=0x20) — SEB/SEH/WSBH/WSBW/BITREV
      // Sub-opcode is in shamt field (bits 10-6)
      const sub = i.shamt;
      switch (sub) {
        case 2:  // WSBH — swap bytes within halfwords
          r.setGpr(i.rd, (((r.getGpr(i.rt) & 0xFF00FF00) >>> 8) | ((r.getGpr(i.rt) & 0x00FF00FF) << 8)) >>> 0);
          break;
        case 3: { // WSBW — swap all bytes (byte-reverse word)
          const v = r.getGpr(i.rt) >>> 0;
          r.setGpr(i.rd, (((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | ((v >>> 24) & 0xFF)) >>> 0);
          break;
        }
        case 16: { // SEB — sign-extend byte
          const v = r.getGpr(i.rt) & 0xFF;
          r.setGpr(i.rd, (v & 0x80) ? (v | 0xFFFFFF00) : v);
          break;
        }
        case 20: { // BITREV — reverse bits
          let v = r.getGpr(i.rt) >>> 0;
          let out = 0;
          for (let b = 0; b < 32; b++) { out = (out << 1) | (v & 1); v >>>= 1; }
          r.setGpr(i.rd, out >>> 0);
          break;
        }
        case 24: { // SEH — sign-extend halfword
          const v = r.getGpr(i.rt) & 0xFFFF;
          r.setGpr(i.rd, (v & 0x8000) ? (v | 0xFFFF0000) : v);
          break;
        }
        default:
          break;
      }
      break;
    }
    case 0x3b: { // RDHWR — read hardware register
      const hwreg = i.rd;
      if (hwreg === 29) {
        r.setGpr(i.rt, r.getGpr(26)); // ULR → use $k0 as TLS base
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
    case 0x00: { const rm = r.fcr31 & 3; const fs = r.fcr31 & (1 << 24); r.setFpr(fd, fpuFlush(fpuRound(s + t, rm), fs)); break; }  // ADD.S
    case 0x01: { const rm = r.fcr31 & 3; const fs = r.fcr31 & (1 << 24); r.setFpr(fd, fpuFlush(fpuRound(s - t, rm), fs)); break; }  // SUB.S
    case 0x02: { const rm = r.fcr31 & 3; const fs = r.fcr31 & (1 << 24); r.setFpr(fd, fpuFlush(fpuRound(s * t, rm), fs)); break; }  // MUL.S
    case 0x03: { const rm = r.fcr31 & 3; const fs = r.fcr31 & (1 << 24); r.setFpr(fd, fpuFlush(fpuRound(s / t, rm), fs)); break; }  // DIV.S
    case 0x04: { const rm = r.fcr31 & 3; const fs = r.fcr31 & (1 << 24); r.setFpr(fd, fpuFlush(fpuRound(Math.sqrt(s), rm), fs)); break; } // SQRT.S
    case 0x05: r.setFpr(fd, Math.abs(s)); break;  // ABS.S
    case 0x06: r.setFpr(fd, s); break;        // MOV.S
    case 0x07: r.setFpr(fd, -s); break;       // NEG.S
    case 0x0c: // ROUND.W.S — round to nearest even
      if (!isFinite(s)) { r.setFprBits(fd, s < 0 ? 0x80000000 : 0x7FFFFFFF); break; }
      r.setFprBits(fd, roundToNearestEven(s) >>> 0);
      break;
    case 0x0d: // TRUNC.W.S
      if (!isFinite(s)) { r.setFprBits(fd, s < 0 ? 0x80000000 : 0x7FFFFFFF); break; }
      r.setFprBits(fd, (Math.trunc(s) | 0) >>> 0);
      break;
    case 0x0e: // CEIL.W.S
      if (!isFinite(s)) { r.setFprBits(fd, s < 0 ? 0x80000000 : 0x7FFFFFFF); break; }
      r.setFprBits(fd, (Math.ceil(s) | 0) >>> 0);
      break;
    case 0x0f: // FLOOR.W.S
      if (!isFinite(s)) { r.setFprBits(fd, s < 0 ? 0x80000000 : 0x7FFFFFFF); break; }
      r.setFprBits(fd, (Math.floor(s) | 0) >>> 0);
      break;
    case 0x24: { // CVT.W.S — convert float to int using FCR31 rounding mode
      if (!isFinite(s)) { r.setFprBits(fd, s < 0 ? 0x80000000 : 0x7FFFFFFF); break; }
      const rm = r.fcr31 & 3;
      let result: number;
      if (rm === 0) result = roundToNearestEven(s);          // round (nearest even)
      else if (rm === 1) result = Math.trunc(s) | 0;        // truncate
      else if (rm === 2) result = Math.ceil(s) | 0;         // ceil
      else result = Math.floor(s) | 0;                      // floor
      r.setFprBits(fd, result >>> 0);
      break;
    }
    default: {
      // C.cond.S comparison instructions (funct 0x30-0x3F)
      if (i.funct >= 0x30 && i.funct <= 0x3f) {
        const cond = i.funct & 0x0f;
        const un = isNaN(s) || isNaN(t);
        let result: boolean;
        switch (cond) {
          case 0: case 8:  result = false; break;                     // f / sf
          case 1: case 9:  result = un; break;                        // un / ngle
          case 2: case 10: result = !un && s === t; break;            // eq / seq
          case 3: case 11: result = s === t || un; break;             // ueq / ngl
          case 4: case 12: result = s < t; break;                     // olt / lt
          case 5: case 13: result = s < t || un; break;               // ult / nge
          case 6: case 14: result = s <= t; break;                    // ole / le
          case 7: case 15: result = s <= t || un; break;              // ule / ngt
          default: result = false; break;
        }
        // Store condition in FCR31 bit 23 (fpcond)
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

/**
 * Maps the lv.s/sv.s register field to a flat vfpr index.
 * PPSSPP Int_SV: vt = ((op >> 16) & 0x1f) | ((op & 3) << 5), accessed as
 * VI(vt) — i.e. through the voffset[] mapping, same as every ALU operand.
 */
function vfpuScalarIndex(i: Instruction): number {
  return vfpuOffset(i.rt | ((i.raw & 3) << 5));
}

/**
 * Maps VFPU register field to a quad of scalar indices.
 * Matches PPSSPP: vt = ((op>>16)&0x1f) | ((op&1)<<5)
 */
function vfpuQuadIndices(i: Instruction): number[] {
  const reg = i.rt | ((i.raw & 1) << 5); // 6-bit register code
  const mtx = ((reg << 2) & 0x70);
  const col = reg & 3;
  const transpose = (reg >>> 5) & 1;
  const row = (reg >>> 5) & 2;

  const indices: number[] = [];
  if (transpose) {
    const base = mtx + col;
    for (let j = 0; j < 4; j++) indices.push(base + ((row + j) & 3) * 4);
  } else {
    const base = mtx + col * 4;
    for (let j = 0; j < 4; j++) indices.push(base + ((row + j) & 3));
  }
  return indices;
}

function execLVS(cpu: AllegrexCPU, i: Instruction): void {
  // Low 2 bits of the offset are part of the register code (PPSSPP: op & 0xFFFC)
  const addr = ((cpu.regs.getGpr(i.rs) + (i.imm16s & ~3)) >>> 0);
  const vt = vfpuScalarIndex(i);
  const bits = cpu.bus.readU32(addr);
  cpu.regs.setVfprBits(vt, bits);
}

function execSVS(cpu: AllegrexCPU, i: Instruction): void {
  const addr = ((cpu.regs.getGpr(i.rs) + (i.imm16s & ~3)) >>> 0);
  const vt = vfpuScalarIndex(i);
  const bits = cpu.regs.getVfprBits(vt);
  cpu.bus.writeU32(addr, bits);
}

// LV.Q — Load VFPU Quad
function execLVQ(cpu: AllegrexCPU, i: Instruction): void {
  const offset = i.imm16s & ~3;
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  const indices = vfpuQuadIndices(i);
  for (let j = 0; j < 4; j++) {
    const bits = cpu.bus.readU32((addr + j * 4) >>> 0);
    cpu.regs.setVfprBits(indices[j]!, bits);
  }
}

// SV.Q — Store VFPU Quad
function execSVQ(cpu: AllegrexCPU, i: Instruction): void {
  const offset = i.imm16s & ~3;
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  const indices = vfpuQuadIndices(i);
  for (let j = 0; j < 4; j++) {
    const bits = cpu.regs.getVfprBits(indices[j]!);
    cpu.bus.writeU32((addr + j * 4) >>> 0, bits);
  }
}

// LV (unaligned quad load — left/right parts)
// LVL.Q / LVR.Q — unaligned VFPU quad load (PPSSPP MIPSIntVFPU.cpp:215-242)
function execLV(cpu: AllegrexCPU, i: Instruction): void {
  const offset = i.imm16s & ~3;
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  const indices = vfpuQuadIndices(i);
  // Read current vector values
  const d = new Float32Array(4);
  for (let j = 0; j < 4; j++) {
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = cpu.regs.getVfprBits(indices[j]!);
    d[j] = new Float32Array(buf)[0]!;
  }
  const alignOffset = (addr >>> 2) & 3;
  if ((i.raw & 2) === 0) {
    // LVL — load left: fill from high end
    for (let j = 0; j < alignOffset + 1; j++) {
      const buf = new ArrayBuffer(4);
      new Uint32Array(buf)[0] = cpu.bus.readU32((addr - 4 * j) >>> 0);
      d[3 - j] = new Float32Array(buf)[0]!;
    }
  } else {
    // LVR — load right: fill from low end
    for (let j = 0; j < (3 - alignOffset) + 1; j++) {
      const buf = new ArrayBuffer(4);
      new Uint32Array(buf)[0] = cpu.bus.readU32((addr + 4 * j) >>> 0);
      d[j] = new Float32Array(buf)[0]!;
    }
  }
  // Write back
  for (let j = 0; j < 4; j++) {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = d[j]!;
    cpu.regs.setVfprBits(indices[j]!, new Uint32Array(buf)[0]!);
  }
}

// SVL.Q / SVR.Q — unaligned VFPU quad store (PPSSPP MIPSIntVFPU.cpp:265-290)
function execSV(cpu: AllegrexCPU, i: Instruction): void {
  const offset = i.imm16s & ~3;
  const addr = ((cpu.regs.getGpr(i.rs) + offset) >>> 0);
  const indices = vfpuQuadIndices(i);
  const d = new Uint32Array(4);
  for (let j = 0; j < 4; j++) d[j] = cpu.regs.getVfprBits(indices[j]!);
  const alignOffset = (addr >>> 2) & 3;
  if ((i.raw & 2) === 0) {
    // SVL — store left
    for (let j = 0; j < alignOffset + 1; j++) {
      cpu.bus.writeU32((addr - 4 * j) >>> 0, d[3 - j]!);
    }
  } else {
    // SVR — store right
    for (let j = 0; j < (3 - alignOffset) + 1; j++) {
      cpu.bus.writeU32((addr + 4 * j) >>> 0, d[j]!);
    }
  }
}

// ── VFPU register read/write helpers (matching PPSSPP MIPSVFPUUtils.cpp) ──

/** Compute VFPU vector size from instruction encoding. */
function vfpuVecSize(raw: number): number {
  return ((raw >>> 7) & 1) + ((raw >>> 14) & 2) + 1; // 1=S, 2=P, 3=T, 4=Q
}

/** Read VFPU vector elements into an array. */
function vfpuReadVec(r: AllegrexRegisters, reg: number, size: number): Float32Array {
  const out = new Float32Array(size);
  if (size === 1) {
    // Single — use voffset table
    out[0] = r.getVfpr(vfpuOffset(reg));
    return out;
  }
  let row: number;
  switch (size) {
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: return out;
  }
  const transpose = (reg >>> 5) & 1;
  const mtx = (reg << 2) & 0x70;
  const col = reg & 3;
  if (transpose) {
    const base = mtx + col;
    for (let i = 0; i < size; i++) out[i] = r.getVfpr(base + ((row + i) & 3) * 4);
  } else {
    const base = mtx + col * 4;
    for (let i = 0; i < size; i++) out[i] = r.getVfpr(base + ((row + i) & 3));
  }
  return out;
}

/** Write VFPU vector elements from an array. */
function vfpuWriteVec(r: AllegrexRegisters, reg: number, size: number, data: Float32Array): void {
  if (size === 1) {
    r.setVfpr(vfpuOffset(reg), data[0]!);
    return;
  }
  let row: number;
  switch (size) {
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: return;
  }
  const mtx = (reg << 2) & 0x70;
  const col = reg & 3;
  const transpose = (reg >>> 5) & 1;
  if (transpose) {
    const base = mtx + col;
    for (let i = 0; i < size; i++) r.setVfpr(base + ((row + i) & 3) * 4, data[i]!);
  } else {
    const base = mtx + col * 4;
    for (let i = 0; i < size; i++) r.setVfpr(base + ((row + i) & 3), data[i]!);
  }
}

/** PPSSPP voffset[] — maps 7-bit scalar register code to flat index 0-127. */
function vfpuOffset(reg: number): number {
  const mtx = (reg << 2) & 0x70;
  const col = reg & 3;
  const row = (reg >>> 5) & 3;
  return mtx + col * 4 + row;
}

/** Read a single VFPU element as u32 bits. */
function vfpuReadBits(r: AllegrexRegisters, reg: number): number {
  return r.getVfprBits(vfpuOffset(reg));
}

// ── VFPU operand prefixes (vpfxs/vpfxt/vpfxd) ──────────────────────────────
// Prefix word layout (PPSSPP GPUState / MIPSIntVFPU ApplySwizzleS/T):
//   bits 0-7:  swizzle, 2 bits per lane (source lane index)
//   bits 8-11: abs flag per lane
//   bits 12-15: constant flag per lane (swizzle+abs then select a constant)
//   bits 16-19: negate flag per lane
const VFPU_PFX_CONSTANTS = [0, 1, 2, 0.5, 3, 1 / 3, 0.25, 1 / 6];

/** Apply an S/T prefix to operand lanes (swizzle / abs / constant / negate). */
function applyPfxST(v: Float32Array, pfx: number): Float32Array {
  const src = Float32Array.from(v);
  for (let i = 0; i < v.length; i++) {
    const swz = (pfx >>> (i * 2)) & 3;
    const abs = (pfx >>> (8 + i)) & 1;
    const cst = (pfx >>> (12 + i)) & 1;
    const neg = (pfx >>> (16 + i)) & 1;
    let val: number;
    if (cst) {
      val = VFPU_PFX_CONSTANTS[swz | (abs << 2)]!;
    } else {
      // Swizzling beyond the operand size reads stale lanes on hardware;
      // approximate by clamping to the available lanes.
      val = src[swz < src.length ? swz : src.length - 1]!;
      if (abs) val = Math.abs(val);
    }
    if (neg) val = -val;
    v[i] = val;
  }
  return v;
}

/** Read the S operand, honoring a pending vpfxs prefix. */
function readVecS(r: AllegrexRegisters, reg: number, size: number): Float32Array {
  const v = vfpuReadVec(r, reg, size);
  return r.vpfxsEnabled ? applyPfxST(v, r.vpfxs) : v;
}

/** Read the T operand, honoring a pending vpfxt prefix. */
function readVecT(r: AllegrexRegisters, reg: number, size: number): Float32Array {
  const v = vfpuReadVec(r, reg, size);
  return r.vpfxtEnabled ? applyPfxST(v, r.vpfxt) : v;
}

/** Write the D result, honoring a pending vpfxd prefix (saturation + write mask). */
function writeVecD(r: AllegrexRegisters, reg: number, size: number, data: Float32Array): void {
  let out = data;
  if (r.vpfxdEnabled) {
    const pfx = r.vpfxd;
    const cur = vfpuReadVec(r, reg, size);
    out = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const sat = (pfx >>> (i * 2)) & 3;
      const masked = (pfx >>> (8 + i)) & 1;
      let v = data[i]!;
      if (sat === 1) v = Math.min(1, Math.max(0, v));
      else if (sat === 3) v = Math.min(1, Math.max(-1, v));
      out[i] = masked ? cur[i]! : v;
    }
  }
  vfpuWriteVec(r, reg, size, out);
}

/** Read VFPU vector as u32 bits. */
function vfpuReadVecBits(r: AllegrexRegisters, reg: number, size: number): Uint32Array {
  const out = new Uint32Array(size);
  if (size === 1) { out[0] = r.getVfprBits(vfpuOffset(reg)); return out; }
  let row: number;
  switch (size) {
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: return out;
  }
  const transpose = (reg >>> 5) & 1;
  const mtx = (reg << 2) & 0x70;
  const col = reg & 3;
  if (transpose) {
    const base = mtx + col;
    for (let i = 0; i < size; i++) out[i] = r.getVfprBits(base + ((row + i) & 3) * 4);
  } else {
    const base = mtx + col * 4;
    for (let i = 0; i < size; i++) out[i] = r.getVfprBits(base + ((row + i) & 3));
  }
  return out;
}

/** Write VFPU vector as u32 bits. */
function vfpuWriteVecBits(r: AllegrexRegisters, reg: number, size: number, data: Uint32Array): void {
  if (size === 1) { r.setVfprBits(vfpuOffset(reg), data[0]!); return; }
  let row: number;
  switch (size) {
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: return;
  }
  const mtx = (reg << 2) & 0x70;
  const col = reg & 3;
  const transpose = (reg >>> 5) & 1;
  if (transpose) {
    const base = mtx + col;
    for (let i = 0; i < size; i++) r.setVfprBits(base + ((row + i) & 3) * 4, data[i]!);
  } else {
    const base = mtx + col * 4;
    for (let i = 0; i < size; i++) r.setVfprBits(base + ((row + i) & 3), data[i]!);
  }
}

// VFPU constant table (vcst instruction) — PPSSPP MIPSVFPUUtils.cpp:cst_constants
const VFPU_CST: Float32Array = new Float32Array([
  0, Infinity, Math.sqrt(2), Math.sqrt(0.5), 2/Math.sqrt(Math.PI),
  2/Math.PI, 1/Math.PI, Math.PI/4, Math.PI/2, Math.PI,
  Math.E, Math.LOG2E, Math.LOG10E, Math.LN2, Math.LN10,
  2*Math.PI, Math.PI/6, Math.log2(Math.E), Math.log2(3), Math.log2(7),
]);

// ── VFPU4Jump dispatch (opcode 0x34) ──────────────────────────────────
function execVFPU4Jump(cpu: AllegrexCPU, i: Instruction): void {
  const raw = i.raw;
  const r = cpu.regs;
  const rs = (raw >>> 21) & 0x1F;
  const rt = (raw >>> 16) & 0x1F;
  const vd = raw & 0x7F;
  const vs = (raw >>> 8) & 0x7F;
  const sz = vfpuVecSize(raw);

  // Float-to-int conversions (rs=16..19)
  if (rs >= 16 && rs <= 19) {
    const src = readVecS(r, vs, sz);
    const imm = (raw >>> 16) & 0x1F;
    const mult = (1 << imm);
    const dst = new Uint32Array(sz);
    for (let j = 0; j < sz; j++) {
      const s = src[j]!;
      if (isNaN(s)) { dst[j] = 0x7FFFFFFF; continue; } // NaN → INT_MAX
      if (s === Infinity) { dst[j] = 0x7FFFFFFF; continue; }  // +Inf → INT_MAX
      if (s === -Infinity) { dst[j] = 0x80000000; continue; } // -Inf → INT_MIN
      const sv = s * mult;
      if (sv > 0x7FFFFFFF) { dst[j] = 0x7FFFFFFF; continue; }
      if (sv <= -2147483648) { dst[j] = 0x80000000; continue; }
      switch (rs) {
        case 16: dst[j] = (roundToNearestEven(sv)) >>> 0; break; // vf2in
        case 17: dst[j] = (s >= 0 ? Math.floor(sv) : Math.ceil(sv)) >>> 0; break; // vf2iz
        case 18: dst[j] = (Math.ceil(sv) | 0) >>> 0; break;      // vf2iu
        case 19: dst[j] = (Math.floor(sv) | 0) >>> 0; break;     // vf2id
      }
    }
    vfpuWriteVecBits(r, vd, sz, dst);
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // Int-to-float (rs=20)
  if (rs === 20) {
    const srcBits = vfpuReadVecBits(r, vs, sz);
    const imm = (raw >>> 16) & 0x1F;
    const scale = 1.0 / (1 << imm);
    const dst = new Float32Array(sz);
    for (let j = 0; j < sz; j++) dst[j] = (srcBits[j]! | 0) * scale;
    writeVecD(r, vd, sz, dst);
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // vcmov (rs=21) — conditional move
  if (rs === 21) {
    // TODO: implement conditional move
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // vcst (rs=3) — load constant
  if (rs === 3) {
    const constIdx = (raw >>> 16) & 0x1F;
    const val = constIdx < VFPU_CST.length ? VFPU_CST[constIdx]! : 0;
    const dst = new Float32Array(sz);
    for (let j = 0; j < sz; j++) dst[j] = val;
    writeVecD(r, vd, sz, dst);
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // VFPU4 table (rs=0)
  if (rs === 0) {
    const src = readVecS(r, vs, sz);
    const dst = new Float32Array(sz);
    switch (rt) {
      case 0: for (let j = 0; j < sz; j++) dst[j] = src[j]!; break; // vmov
      case 1: for (let j = 0; j < sz; j++) dst[j] = Math.abs(src[j]!); break; // vabs
      case 2: for (let j = 0; j < sz; j++) dst[j] = -src[j]!; break; // vneg
      case 3: // vidt — identity
        for (let j = 0; j < sz; j++) dst[j] = 0;
        { const col = vd & 3; if (col < sz) dst[col] = 1; }
        break;
      case 4: for (let j = 0; j < sz; j++) dst[j] = Math.min(Math.max(src[j]!, 0), 1); break; // vsat0
      case 5: for (let j = 0; j < sz; j++) dst[j] = Math.min(Math.max(src[j]!, -1), 1); break; // vsat1
      case 6: for (let j = 0; j < sz; j++) dst[j] = 0; break; // vzero
      case 7: for (let j = 0; j < sz; j++) dst[j] = 1; break; // vone
      case 16: for (let j = 0; j < sz; j++) dst[j] = 1.0 / src[j]!; break; // vrcp
      case 17: for (let j = 0; j < sz; j++) dst[j] = 1.0 / Math.sqrt(src[j]!); break; // vrsq
      case 18: for (let j = 0; j < sz; j++) dst[j] = Math.sin(src[j]! * (Math.PI / 2)); break; // vsin
      case 19: for (let j = 0; j < sz; j++) dst[j] = Math.cos(src[j]! * (Math.PI / 2)); break; // vcos
      case 20: for (let j = 0; j < sz; j++) dst[j] = Math.pow(2, src[j]!); break; // vexp2
      case 21: for (let j = 0; j < sz; j++) dst[j] = Math.log2(src[j]!); break; // vlog2
      case 22: for (let j = 0; j < sz; j++) dst[j] = Math.sqrt(src[j]!); break; // vsqrt
      case 23: for (let j = 0; j < sz; j++) dst[j] = Math.asin(src[j]!) / (Math.PI / 2); break; // vasin
      case 24: for (let j = 0; j < sz; j++) dst[j] = -1.0 / src[j]!; break; // vnrcp
      case 26: for (let j = 0; j < sz; j++) dst[j] = -Math.sin(src[j]! * (Math.PI / 2)); break; // vnsin
      case 28: for (let j = 0; j < sz; j++) dst[j] = 1.0 / Math.pow(2, src[j]!); break; // vrexp2
      default: break; // unknown — NOP
    }
    writeVecD(r, vd, sz, dst);
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // VFPU7 table (rs=1) — color/int conversions
  if (rs === 1) {
    switch (rt) {
      case 24: { // vuc2i — unsigned char to int (8-bit to 31-bit, with swizzle multiply)
        const srcBits = vfpuReadVecBits(r, vs, 1);
        let val = srcBits[0]!;
        const dst = new Uint32Array(4);
        for (let j = 0; j < 4; j++) {
          dst[j] = (Math.imul(val & 0xFF, 0x01010101) >>> 1);
          val >>>= 8;
        }
        vfpuWriteVecBits(r, vd, 4, dst);
        break;
      }
      case 25: { // vc2i — char to int (PPSSPP: each byte shifted to top, no swizzle)
        const srcBits = vfpuReadVecBits(r, vs, 1);
        const val = srcBits[0]!;
        const dst = new Uint32Array(4);
        dst[0] = (val & 0xFF) << 24;
        dst[1] = (val & 0xFF00) << 16;
        dst[2] = (val & 0xFF0000) << 8;
        dst[3] = (val & 0xFF000000) >>> 0;
        vfpuWriteVecBits(r, vd, 4, dst);
        break;
      }
      case 26: { // vus2i — unsigned short to int (expand each u16 to 32-bit)
        const srcBits = vfpuReadVecBits(r, vs, sz);
        const halfSz = sz;
        const dst = new Uint32Array(halfSz * 2);
        for (let j = 0; j < halfSz; j++) {
          dst[j * 2] = (srcBits[j]! & 0xFFFF) << 15;
          dst[j * 2 + 1] = (srcBits[j]! >>> 16) << 15;
        }
        vfpuWriteVecBits(r, vd, halfSz * 2, dst);
        break;
      }
      case 27: { // vs2i — signed short to int
        const srcBits = vfpuReadVecBits(r, vs, sz);
        const halfSz = sz;
        const dst = new Uint32Array(halfSz * 2);
        for (let j = 0; j < halfSz; j++) {
          dst[j * 2] = (srcBits[j]! & 0xFFFF) << 16;
          dst[j * 2 + 1] = (srcBits[j]! & 0xFFFF0000) >>> 0;
        }
        vfpuWriteVecBits(r, vd, halfSz * 2, dst);
        break;
      }
      case 28: { // vi2uc — int to unsigned char (pack 4 ints → 1 word)
        const srcBits = vfpuReadVecBits(r, vs, 4);
        let result = 0;
        for (let j = 0; j < 4; j++) {
          const v = Math.max(0, Math.min(0xFF, (srcBits[j]! | 0) >> 23));
          result |= (v & 0xFF) << (j * 8);
        }
        vfpuWriteVecBits(r, vd, 1, new Uint32Array([result >>> 0]));
        break;
      }
      case 29: { // vi2c — int to char (pack 4 ints → 1 word)
        const srcBits = vfpuReadVecBits(r, vs, 4);
        let result = 0;
        for (let j = 0; j < 4; j++) {
          result |= ((srcBits[j]! >>> 24) & 0xFF) << (j * 8);
        }
        vfpuWriteVecBits(r, vd, 1, new Uint32Array([result >>> 0]));
        break;
      }
      case 30: { // vi2us — int to unsigned short (pack 2 ints → 1 word)
        const srcBits = vfpuReadVecBits(r, vs, sz);
        const dstSz = Math.max(1, sz >> 1);
        const dst = new Uint32Array(dstSz);
        for (let j = 0; j < dstSz; j++) {
          const lo = Math.max(0, (srcBits[j * 2]! | 0) >> 15) & 0xFFFF;
          const hi = Math.max(0, (srcBits[j * 2 + 1]! | 0) >> 15) & 0xFFFF;
          dst[j] = (lo | (hi << 16)) >>> 0;
        }
        vfpuWriteVecBits(r, vd, dstSz, dst);
        break;
      }
      case 31: { // vi2s — int to short
        const srcBits = vfpuReadVecBits(r, vs, sz);
        const dstSz = Math.max(1, sz >> 1);
        const dst = new Uint32Array(dstSz);
        for (let j = 0; j < dstSz; j++) {
          const lo = (srcBits[j * 2]! >>> 16) & 0xFFFF;
          const hi = (srcBits[j * 2 + 1]! >>> 16) & 0xFFFF;
          dst[j] = (lo | (hi << 16)) >>> 0;
        }
        vfpuWriteVecBits(r, vd, dstSz, dst);
        break;
      }
      case 18: { // vf2h — float to half
        const src = readVecS(r, vs, sz);
        const dstSz = Math.max(1, sz >> 1);
        const dst = new Uint32Array(dstSz);
        for (let j = 0; j < dstSz; j++) {
          const lo = floatToHalf(src[j * 2]!);
          const hi = (j * 2 + 1 < sz) ? floatToHalf(src[j * 2 + 1]!) : 0;
          dst[j] = (lo | (hi << 16)) >>> 0;
        }
        vfpuWriteVecBits(r, vd, dstSz, dst);
        break;
      }
      case 19: { // vh2f — half to float (use bits to preserve NaN patterns)
        const srcBits = vfpuReadVecBits(r, vs, sz);
        const dstSz = sz * 2;
        const dst = new Uint32Array(dstSz);
        for (let j = 0; j < sz; j++) {
          dst[j * 2] = halfToFloatBits(srcBits[j]! & 0xFFFF);
          dst[j * 2 + 1] = halfToFloatBits(srcBits[j]! >>> 16);
        }
        vfpuWriteVecBits(r, vd, dstSz, dst);
        break;
      }
      default: break; // NOP for unimplemented
    }
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // VFPU9 table (rs=2) — utility operations
  if (rs === 2) {
    switch (rt) {
      case 0: { // vsrt1 — PPSSPP Int_Vsrt1: pairwise min/max
        const s = readVecS(r, vs, 4);
        const d = new Float32Array([
          Math.min(s[0]!, s[1]!), Math.max(s[0]!, s[1]!),
          Math.min(s[2]!, s[3]!), Math.max(s[2]!, s[3]!),
        ]);
        writeVecD(r, vd, 4, d);
        break;
      }
      case 1: { // vsrt2 — PPSSPP Int_Vsrt2: outer/inner min/max
        const s = readVecS(r, vs, 4);
        const d = new Float32Array([
          Math.min(s[0]!, s[3]!), Math.min(s[1]!, s[2]!),
          Math.max(s[2]!, s[1]!), Math.max(s[3]!, s[0]!),
        ]);
        writeVecD(r, vd, 4, d);
        break;
      }
      case 2: { // vbfy1 — PPSSPP Int_Vbfy: butterfly add/sub on adjacent pairs
        const s = readVecS(r, vs, sz);
        const d = new Float32Array(sz);
        d[0] = s[0]! + s[1]!;
        d[1] = s[0]! - s[1]!;
        if (sz === 4) {
          d[2] = s[2]! + s[3]!;
          d[3] = s[2]! - s[3]!;
        }
        writeVecD(r, vd, sz, d);
        break;
      }
      case 3: { // vbfy2 — butterfly add/sub across halves (quad only)
        const s = readVecS(r, vs, 4);
        const d = new Float32Array([
          s[0]! + s[2]!, s[1]! + s[3]!,
          s[0]! - s[2]!, s[1]! - s[3]!,
        ]);
        writeVecD(r, vd, 4, d);
        break;
      }
      case 5: { // vsocp — PPSSPP Int_Vsocp: [clamp(1-s0), clamp(s0), ...], output size doubles
        const s = readVecS(r, vs, sz);
        const outSz = Math.min(4, sz * 2);
        const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));
        const d = new Float32Array(outSz);
        d[0] = clamp01(1 - s[0]!);
        d[1] = clamp01(s[0]!);
        if (outSz === 4) {
          d[2] = clamp01(1 - s[1]!);
          d[3] = clamp01(s[1]!);
        }
        writeVecD(r, vd, outSz, d);
        break;
      }
      case 8: { // vsrt3 — like vsrt1 with max/min swapped
        const s = readVecS(r, vs, 4);
        const d = new Float32Array([
          Math.max(s[0]!, s[1]!), Math.min(s[1]!, s[0]!),
          Math.max(s[2]!, s[3]!), Math.min(s[3]!, s[2]!),
        ]);
        writeVecD(r, vd, 4, d);
        break;
      }
      case 9: { // vsrt4 — like vsrt2 with max/min swapped
        const s = readVecS(r, vs, 4);
        const d = new Float32Array([
          Math.max(s[0]!, s[3]!), Math.max(s[1]!, s[2]!),
          Math.min(s[2]!, s[1]!), Math.min(s[3]!, s[0]!),
        ]);
        writeVecD(r, vd, 4, d);
        break;
      }
      case 4: { // vocp — one's complement: 1.0 - x
        const src = readVecS(r, vs, sz);
        const dst = new Float32Array(sz);
        for (let j = 0; j < sz; j++) dst[j] = 1.0 - src[j]!;
        writeVecD(r, vd, sz, dst);
        break;
      }
      case 6: { // vfad — horizontal add
        const src = readVecS(r, vs, sz);
        let sum = 0;
        for (let j = 0; j < sz; j++) sum += src[j]!;
        writeVecD(r, vd, 1, new Float32Array([sum]));
        break;
      }
      case 7: { // vavg — horizontal average
        const src = readVecS(r, vs, sz);
        let sum = 0;
        for (let j = 0; j < sz; j++) sum += src[j]!;
        writeVecD(r, vd, 1, new Float32Array([sum / sz]));
        break;
      }
      case 10: { // vsgn — sign function
        const src = readVecS(r, vs, sz);
        const dst = new Float32Array(sz);
        for (let j = 0; j < sz; j++) {
          const v = src[j]!;
          dst[j] = v > 0 ? 1 : v < 0 ? -1 : 0;
        }
        writeVecD(r, vd, sz, dst);
        break;
      }
      case 16: { // vmfvc — move from VFPU control
        const vcReg = (raw >>> 8) & 0x7F;
        if (vcReg < 16) {
          r.setVfprBits(vfpuOffset(vd), r.vfpuCtrl[vcReg]!);
        } else if (vcReg === 128) {
          r.setVfprBits(vfpuOffset(vd), r.vfpuCc);
        }
        break;
      }
      case 17: { // vmtvc — move to VFPU control
        const vcReg = (raw >>> 8) & 0x7F;
        const val = r.getVfprBits(vfpuOffset(vs));
        if (vcReg < 16) {
          r.vfpuCtrl[vcReg] = val;
        } else if (vcReg === 128) {
          r.vfpuCc = val;
        }
        break;
      }
      case 25: case 26: case 27: { // vt4444/vt5551/vt5650 — PPSSPP Int_ColorConv
        const srcBits = vfpuReadVecBits(r, vs, 4); // always read quad
        const fmt = rt - 24; // 1=4444, 2=5551, 3=5650
        const colors = new Uint16Array(4);
        for (let j = 0; j < 4; j++) {
          const inp = srcBits[j]!;
          switch (fmt) {
            case 1: { // 4444
              const a1 = ((inp >>> 24) & 0xFF) >>> 4;
              const b1 = ((inp >>> 16) & 0xFF) >>> 4;
              const g1 = ((inp >>> 8) & 0xFF) >>> 4;
              const r1 = (inp & 0xFF) >>> 4;
              colors[j] = (a1 << 12) | (b1 << 8) | (g1 << 4) | r1;
              break;
            }
            case 2: { // 5551
              const a2 = ((inp >>> 24) & 0xFF) >>> 7;
              const b2 = ((inp >>> 16) & 0xFF) >>> 3;
              const g2 = ((inp >>> 8) & 0xFF) >>> 3;
              const r2 = (inp & 0xFF) >>> 3;
              colors[j] = (a2 << 15) | (b2 << 10) | (g2 << 5) | r2;
              break;
            }
            case 3: { // 565
              const b3 = ((inp >>> 16) & 0xFF) >>> 3;
              const g3 = ((inp >>> 8) & 0xFF) >>> 2;
              const r3 = (inp & 0xFF) >>> 3;
              colors[j] = (b3 << 11) | (g3 << 5) | r3;
              break;
            }
          }
        }
        const ov = new Uint32Array(2);
        ov[0] = (colors[0]! | (colors[1]! << 16)) >>> 0;
        ov[1] = (colors[2]! | (colors[3]! << 16)) >>> 0;
        vfpuWriteVecBits(r, vd, sz === 1 ? 1 : 2, ov);
        break;
      }
      default: break; // NOP
    }
    r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
    return;
  }

  // vwbn (rs=24..31) — NOP for now
  // Unknown rs — NOP
  r.vpfxsEnabled = false;
  r.vpfxtEnabled = false;
  r.vpfxdEnabled = false;
}

// PPSSPP float_to_half_fast3 — PSP-compatible float-to-half conversion
function floatToHalf(f: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = f;
  const u = new Uint32Array(buf)[0]!;
  const sign = (u >>> 16) & 0x8000;
  const abs = u & 0x7FFFFFFF;
  if (abs >= 0x7F800000) {
    // Inf or NaN
    return sign | (abs > 0x7F800000 ? (0x7E00 | (u & 0x3FF)) : 0x7C00);
  }
  // Normal/denormal: simple shift (approximate, matches PPSSPP for typical values)
  const exp = ((abs >>> 23) & 0xFF) - 127 + 15;
  const mant = (abs >>> 13) & 0x3FF;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7C00;
  return sign | (exp << 10) | mant;
}

/** halfToFloatBits — returns raw u32 bits (preserves NaN bit patterns). */
function halfToFloatBits(h: number): number {
  const sign = (h >>> 15) & 1;
  let exp = (h >>> 10) & 0x1F;
  let frac = h & 0x3FF;
  if (exp === 31) {
    return (sign << 31) | (0xFF << 23) | frac; // Inf or NaN: copy frac to low bits
  } else if (exp === 0 && frac === 0) {
    return sign << 31;
  } else {
    if (exp === 0) {
      do { frac <<= 1; exp--; } while (!(frac & 0x400));
      exp++; frac &= 0x3FF;
    }
    return (sign << 31) | ((exp + 127 - 15) << 23) | (frac << 13);
  }
}

// PPSSPP Float16ToFloat32 — PSP-specific half-float format (returns float)
function halfToFloat(h: number): number {
  const sign = (h >>> 15) & 1;
  let exp = (h >>> 10) & 0x1F;
  let frac = h & 0x3FF;
  let bits: number;
  if (exp === 31) {
    // Inf or NaN: copy fraction directly into low bits (PSP quirk)
    bits = (sign << 31) | (0xFF << 23) | frac;
  } else if (exp === 0 && frac === 0) {
    bits = sign << 31; // ±0
  } else {
    if (exp === 0) {
      // Denormalized: normalize
      do { frac <<= 1; exp--; } while (!(frac & 0x400));
      exp++; frac &= 0x3FF;
    }
    bits = (sign << 31) | ((exp + 127 - 15) << 23) | (frac << 13);
  }
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = bits;
  return new Float32Array(buf)[0]!;
}

// VFPU5 — prefix instructions (VPFXS/VPFXT/VPFXD) + viim.s/vfim.s
// Sub-dispatch on bits 25-23: 0,1=VPFXS  2,3=VPFXT  4,5=VPFXD  6=viim  7=vfim
function execVFPU5(cpu: AllegrexCPU, i: Instruction): void {
  const sub = (i.raw >>> 23) & 0x7;
  const data = i.raw & 0x000FFFFF;
  const r = cpu.regs;
  if (sub <= 1) {
    r.vpfxs = data;
    r.vpfxsEnabled = true;
  } else if (sub <= 3) {
    r.vpfxt = data;
    r.vpfxtEnabled = true;
  } else if (sub <= 5) {
    r.vpfxd = data;
    r.vpfxdEnabled = true;
  }
  else if (sub === 6) {
    // viim.s — load 16-bit integer immediate into VFPU scalar
    const vt = (i.raw >>> 16) & 0x7F;
    const imm = i.raw & 0xFFFF;
    const val = (imm & 0x8000) ? imm - 0x10000 : imm; // sign-extend
    r.setVfpr(vfpuOffset(vt), val);
  } else if (sub === 7) {
    // vfim.s — load half-float immediate into VFPU scalar
    const vt = (i.raw >>> 16) & 0x7F;
    const imm = i.raw & 0xFFFF;
    r.setVfpr(vfpuOffset(vt), halfToFloat(imm));
  }
}

// COP2 — VFPU computational instructions
function execCOP2(cpu: AllegrexCPU, i: Instruction): void {
  const r = cpu.regs;
  const fmt = i.rs; // bits 25-21

  // PPSSPP Int_Mftv: fmt 3 = mfv/mfvc, fmt 7 = mtv/mtvc.
  // Register code is the LOW BYTE: <128 = VFPU reg (through voffset),
  // 128..143 = control reg (CC lives at 128+3).
  const imm = i.raw & 0xFF;
  switch (fmt) {
    case 0x03: { // mfv / mfvc
      // rt=0, imm=255 is used as a CPU interlock by some games — no-op.
      if (i.rt !== 0) {
        if (imm < 128) {
          r.setGpr(i.rt, r.getVfprBits(vfpuOffset(imm)));
        } else if (imm < 144) {
          r.setGpr(i.rt, imm === 128 + 3 ? r.vfpuCc : r.vfpuCtrl[imm - 128]!);
        } else {
          r.setGpr(i.rt, 0);
        }
      }
      break;
    }
    case 0x07: { // mtv / mtvc
      if (imm < 128) {
        r.setVfprBits(vfpuOffset(imm), r.getGpr(i.rt));
      } else if (imm < 144) {
        if (imm === 128 + 3) r.vfpuCc = r.getGpr(i.rt);
        else r.vfpuCtrl[imm - 128] = r.getGpr(i.rt);
      }
      break;
    }
    default:
      // fmt 0/4 = mfc2/mtc2 — PPSSPP treats them as generic no-ops.
      break;
  }

  // Clear prefixes after each VFPU op
  r.vpfxsEnabled = false;
  r.vpfxtEnabled = false;
  r.vpfxdEnabled = false;
}

// VFPU0 — vector arithmetic: vadd, vsub, vsbn, vdiv
function execVFPU0(cpu: AllegrexCPU, i: Instruction): void {
  const raw = i.raw;
  const r = cpu.regs;
  const sub = (raw >>> 23) & 7;
  const vd = raw & 0x7F;
  const vs = (raw >>> 8) & 0x7F;
  const vt = (raw >>> 16) & 0x7F;
  const sz = vfpuVecSize(raw);
  const s = readVecS(r, vs, sz);
  const t = readVecT(r, vt, sz);
  const d = new Float32Array(sz);
  switch (sub) {
    case 0: for (let j = 0; j < sz; j++) d[j] = s[j]! + t[j]!; break; // vadd
    case 1: for (let j = 0; j < sz; j++) d[j] = s[j]! - t[j]!; break; // vsub
    case 7: for (let j = 0; j < sz; j++) d[j] = s[j]! / t[j]!; break; // vdiv
    default: break;
  }
  writeVecD(r, vd, sz, d);
  r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
}

// VFPU1 — vector multiply/dot: vmul, vdot, vscl, vhdp, vcrs, vdet
function execVFPU1(cpu: AllegrexCPU, i: Instruction): void {
  const raw = i.raw;
  const r = cpu.regs;
  const sub = (raw >>> 23) & 7;
  const vd = raw & 0x7F;
  const vs = (raw >>> 8) & 0x7F;
  const vt = (raw >>> 16) & 0x7F;
  const sz = vfpuVecSize(raw);

  switch (sub) {
    case 0: { // vmul — element-wise multiply
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = s[j]! * t[j]!;
      writeVecD(r, vd, sz, d);
      break;
    }
    case 1: { // vdot — dot product → scalar
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      let sum = 0;
      for (let j = 0; j < sz; j++) sum += s[j]! * t[j]!;
      writeVecD(r, vd, 1, new Float32Array([sum]));
      break;
    }
    case 2: { // vscl — scale vector by scalar
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, 1); // read single scalar
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = s[j]! * t[0]!;
      writeVecD(r, vd, sz, d);
      break;
    }
    case 4: { // vhdp — homogeneous dot product (last s element = 1.0)
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      let sum = 0;
      for (let j = 0; j < sz - 1; j++) sum += s[j]! * t[j]!;
      sum += 1.0 * t[sz - 1]!; // last s forced to 1.0
      writeVecD(r, vd, 1, new Float32Array([sum]));
      break;
    }
    case 5: { // vcrs — cross product (triple only)
      const s = readVecS(r, vs, 3);
      const t = readVecT(r, vt, 3);
      const d = new Float32Array(3);
      d[0] = s[1]! * t[2]! - s[2]! * t[1]!;
      d[1] = s[2]! * t[0]! - s[0]! * t[2]!;
      d[2] = s[0]! * t[1]! - s[1]! * t[0]!;
      writeVecD(r, vd, 3, d);
      break;
    }
    case 6: { // vdet — 2D determinant
      const s = readVecS(r, vs, 2);
      const t = readVecT(r, vt, 2);
      const det = s[0]! * t[1]! - s[1]! * t[0]!;
      writeVecD(r, vd, 1, new Float32Array([det]));
      break;
    }
    default: break;
  }
  r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
}

// VFPU3 — vector compare/minmax: vcmp, vmin, vmax, vscmp, vsge, vslt
function execVFPU3(cpu: AllegrexCPU, i: Instruction): void {
  const raw = i.raw;
  const r = cpu.regs;
  const sub = (raw >>> 23) & 7;
  const vd = raw & 0x7F;
  const vs = (raw >>> 8) & 0x7F;
  const vt = (raw >>> 16) & 0x7F;
  const sz = vfpuVecSize(raw);

  switch (sub) {
    case 0: { // vcmp — set CC bits based on condition
      const cond = raw & 0xF;
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      let cc = 0;
      let orBit = 0, andBit = 1;
      for (let j = 0; j < sz; j++) {
        const sv = s[j]!, tv = t[j]!;
        let result = false;
        switch (cond) {
          case 0: result = false; break;       // FL
          case 1: result = sv === tv; break;    // EQ
          case 2: result = sv < tv; break;      // LT
          case 3: result = sv <= tv; break;     // LE
          case 4: result = true; break;         // TR
          case 5: result = sv !== tv; break;    // NE
          case 6: result = sv >= tv; break;     // GE
          case 7: result = sv > tv; break;      // GT
          case 8: result = sv === 0 || sv === -0; break; // EZ
          case 9: result = isNaN(sv); break;    // EN
          case 10: result = !isFinite(sv) && !isNaN(sv); break; // EI
          case 11: result = isNaN(sv) || !isFinite(sv); break;  // ES
          case 12: result = sv !== 0; break;    // NZ
          case 13: result = !isNaN(sv); break;  // NN
          case 14: result = isFinite(sv) || isNaN(sv); break;   // NI
          case 15: result = isFinite(sv); break; // NS
        }
        if (result) { cc |= (1 << j); orBit = 1; }
        else andBit = 0;
      }
      cc |= (orBit << 4) | (andBit << 5);
      r.vfpuCc = cc;
      break;
    }
    case 2: { // vmin
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = Math.min(s[j]!, t[j]!);
      writeVecD(r, vd, sz, d);
      break;
    }
    case 3: { // vmax
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = Math.max(s[j]!, t[j]!);
      writeVecD(r, vd, sz, d);
      break;
    }
    case 5: { // vscmp — sign of difference
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) {
        const diff = s[j]! - t[j]!;
        d[j] = diff > 0 ? 1.0 : diff < 0 ? -1.0 : 0.0;
      }
      writeVecD(r, vd, sz, d);
      break;
    }
    case 6: { // vsge — s >= t ? 1.0 : 0.0
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = (s[j]! >= t[j]!) ? 1.0 : 0.0;
      writeVecD(r, vd, sz, d);
      break;
    }
    case 7: { // vslt — s < t ? 1.0 : 0.0
      const s = readVecS(r, vs, sz);
      const t = readVecT(r, vt, sz);
      const d = new Float32Array(sz);
      for (let j = 0; j < sz; j++) d[j] = (s[j]! < t[j]!) ? 1.0 : 0.0;
      writeVecD(r, vd, sz, d);
      break;
    }
    default: break;
  }
  r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
}

// ── VFPU matrix helpers ──────────────────────────────────────────────

/** Get column vector register names for a matrix register. */
function getMatrixColumns(reg: number, n: number): number[] {
  const col = reg & 3;
  const row = (reg >>> 5) & 2;
  const transpose = (reg >>> 5) & 1;
  const vecs: number[] = [];
  for (let k = 0; k < n; k++) {
    vecs.push((transpose << 5) | (row << 5) | (reg & 0x1C) | ((k + col) & 3));
  }
  return vecs;
}

/** Get row vector register names for a matrix register. */
function getMatrixRows(reg: number, n: number): number[] {
  const col = reg & 3;
  const row = (reg >>> 5) & 2;
  const swappedCol = row ? (n === 3 ? 1 : 2) : 0;
  const swappedRow = col ? 2 : 0;
  const transpose = ((reg >>> 5) & 1) ^ 1;
  const vecs: number[] = [];
  for (let k = 0; k < n; k++) {
    vecs.push((transpose << 5) | (swappedRow << 5) | (reg & 0x1C) | ((k + swappedCol) & 3));
  }
  return vecs;
}

/** Read an NxN matrix — matches PPSSPP ReadMatrix exactly.
 *  Output: rd[j*4+i] = register at computed flat index.
 *  Non-transposed: rd[j*4+i] = v[mtx*16 + ((col+j)&3)*4 + ((row+i)&3)]
 *  Transposed:     rd[j*4+i] = v[mtx*16 + ((row+i)&3)*4 + ((col+j)&3)]
 */
function vfpuReadMatrix(r: AllegrexRegisters, reg: number, n: number): Float32Array {
  const transpose = (reg >>> 5) & 1;
  let row: number;
  switch (n) {
    case 1: row = (reg >>> 5) & 3; break;
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: row = 0;
  }
  const mtx = (reg >>> 2) & 7;
  const col = reg & 3;
  const base = mtx * 16;
  // Output matches PPSSPP: rd[j*4+i] where j=column, i=row-within-column
  const rd = new Float32Array(n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = transpose
        ? base + (((row + i) & 3) * 4 + ((col + j) & 3))
        : base + (((col + j) & 3) * 4 + ((row + i) & 3));
      rd[j * 4 + i] = r.getVfpr(idx);
    }
  }
  return rd;
}

/** Write an NxN matrix — rd[j*4+i] where j=column, i=row. */
function vfpuWriteMatrix(r: AllegrexRegisters, reg: number, n: number, rd: Float32Array): void {
  const transpose = (reg >>> 5) & 1;
  let row: number;
  switch (n) {
    case 1: row = (reg >>> 5) & 3; break;
    case 2: row = (reg >>> 5) & 2; break;
    case 3: row = (reg >>> 6) & 1; break;
    case 4: row = (reg >>> 5) & 2; break;
    default: row = 0;
  }
  const mtx = (reg >>> 2) & 7;
  const col = reg & 3;
  const base = mtx * 16;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = transpose
        ? base + (((row + i) & 3) * 4 + ((col + j) & 3))
        : base + (((col + j) & 3) * 4 + ((row + i) & 3));
      r.setVfpr(idx, rd[j * 4 + i]!);
    }
  }
}

// VFPU6 — matrix ops: vmmul, vtfm, vhtfm, vmscl, vcrsp, vqmul, vrot
function execVFPU6(cpu: AllegrexCPU, i: Instruction): void {
  const raw = i.raw;
  const r = cpu.regs;
  const sub5 = (raw >>> 21) & 0x1F; // bits [25:21]
  const vd = raw & 0x7F;
  const vs = (raw >>> 8) & 0x7F;
  const vt = (raw >>> 16) & 0x7F;
  const sz = vfpuVecSize(raw); // matrix side length
  const n = sz;

  if (sub5 <= 3) {
    // vmmul — d[a*4+b] = dot(s[b*4..], t[a*4..]) — PPSSPP Int_Vmmul
    // s/t stored as [col*4+row], so s[b*4+c] = column b, row c
    const sM = vfpuReadMatrix(r, vs, n);
    const tM = vfpuReadMatrix(r, vt, n);
    const dM = new Float32Array(n * 4);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let sum = 0;
        for (let c = 0; c < n; c++) sum += sM[b * 4 + c]! * tM[a * 4 + c]!;
        dM[a * 4 + b] = sum;
      }
    }
    vfpuWriteMatrix(r, vd, n, dM);
  } else if (sub5 <= 15) {
    // vtfm / vhtfm — matrix-vector transform (PPSSPP Int_Vtfm)
    const ins = (raw >>> 23) & 3; // vtfm2=1, vtfm3=2, vtfm4=3
    const tfmSz = ins + 1; // matrix side = ins + 1
    const tn = Math.min(n, ins + 1); // how many t elements to use
    // Read matrix (as flat array, row-major: s[row*4 + col])
    const sM = vfpuReadMatrix(r, vs, tfmSz);
    const tVec = readVecT(r, vt, tn);
    // Build padded t vector with constants for homogeneous transform
    const t2 = new Float32Array(4);
    for (let k = 0; k < 4; k++) {
      if (k < tn) t2[k] = tVec[k]!;
      else if (k === ins) t2[k] = 1.0; // vhtfm: homogeneous coordinate
      else t2[k] = 0;
    }
    // d[i] = dot(s[i*4..], t2) — PPSSPP Int_Vtfm (s stored as s[col*4+row])
    const d = new Float32Array(tfmSz);
    for (let i = 0; i < tfmSz; i++) {
      let sum = 0;
      for (let k = 0; k < tfmSz; k++) sum += sM[i * 4 + k]! * t2[k]!;
      d[i] = sum;
    }
    writeVecD(r, vd, tfmSz, d);
  } else if (sub5 <= 19) {
    // vmscl — matrix scale by scalar
    const sM = vfpuReadMatrix(r, vs, n);
    const t = readVecT(r, vt, 1);
    const scalar = t[0]!;
    const dM = new Float32Array(n * 4);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        dM[j * 4 + i] = sM[j * 4 + i]! * scalar;
    vfpuWriteMatrix(r, vd, n, dM);
  } else if (sub5 <= 23) {
    // vcrsp.t / vqmul.q
    if (sz === 3) {
      // vcrsp — cross product
      const s = readVecS(r, vs, 3);
      const t = readVecT(r, vt, 3);
      const d = new Float32Array(3);
      d[0] = s[1]! * t[2]! - s[2]! * t[1]!;
      d[1] = s[2]! * t[0]! - s[0]! * t[2]!;
      d[2] = s[0]! * t[1]! - s[1]! * t[0]!;
      writeVecD(r, vd, 3, d);
    } else if (sz === 4) {
      // vqmul — quaternion multiply
      const s = readVecS(r, vs, 4);
      const t = readVecT(r, vt, 4);
      const d = new Float32Array(4);
      d[0] = s[0]!*t[3]! + s[1]!*t[2]! - s[2]!*t[1]! + s[3]!*t[0]!;
      d[1] = -s[0]!*t[2]! + s[1]!*t[3]! + s[2]!*t[0]! + s[3]!*t[1]!;
      d[2] = s[0]!*t[1]! - s[1]!*t[0]! + s[2]!*t[3]! + s[3]!*t[2]!;
      d[3] = -s[0]!*t[0]! - s[1]!*t[1]! - s[2]!*t[2]! + s[3]!*t[3]!;
      writeVecD(r, vd, 4, d);
    }
  } else if (sub5 === 28) {
    // VFPUMatrix1: vmidt, vmzero, vmone
    const rt = (raw >>> 16) & 0x1F;
    const dM = new Float32Array(n * 4);
    switch (rt) {
      case 3: // vmidt — identity
        for (let c = 0; c < n; c++)
          for (let row = 0; row < n; row++)
            dM[c * 4 + row] = (c === row) ? 1.0 : 0.0;
        break;
      case 6: // vmzero — all zeros
        // already zero
        break;
      case 7: // vmone — all ones
        dM.fill(1.0);
        break;
      default: break;
    }
    vfpuWriteMatrix(r, vd, n, dM);
  } else if (sub5 === 29) {
    // vrot — rotation row generator
    const imm5 = (raw >>> 16) & 0x1F;
    const negSin = (imm5 >>> 4) & 1;
    const sinLane = (imm5 >>> 2) & 3;
    const cosLane = imm5 & 3;
    const angle = readVecS(r, vs, 1)[0]!;
    let sinV = Math.sin(angle * (Math.PI / 2));
    const cosV = Math.cos(angle * (Math.PI / 2));
    if (negSin) sinV = -sinV;
    const d = new Float32Array(sz);
    // PPSSPP Int_Vrot: if sin lane == cos lane, sine broadcasts to ALL lanes
    if (sinLane === cosLane) d.fill(sinV);
    else d[sinLane] = sinV;
    d[cosLane] = cosV;
    writeVecD(r, vd, sz, d);
  }

  r.vpfxsEnabled = false; r.vpfxtEnabled = false; r.vpfxdEnabled = false;
}
