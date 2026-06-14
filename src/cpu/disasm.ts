/**
 * MIPS Allegrex disassembler — raw 32-bit word to a readable string.
 *
 * One source of truth shared by tools (disasm-addr.ts) and the interpreter
 * profiler's hot-PC report (cpu-profiler.ts). Integer ops decode with full
 * operands; FPU/VFPU and other coprocessor ops show the mnemonic only (their
 * operand encodings are large and not needed for the profiler's hot-PC view).
 * Opcode map mirrors executor.ts.
 */

import { OP, FUNC, REGIMM, FUNC3 } from "./opcodes.js";

const REG = [
  "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
] as const;
const r = (n: number): string => "$" + (REG[n & 31] ?? n);
const hx = (n: number): string => "0x" + (n >>> 0).toString(16);

/** SPECIAL (op 0) by funct. */
function disasmSpecial(raw: number, rs: number, rt: number, rd: number, sa: number): string {
  const fn = raw & 0x3f;
  switch (fn) {
    case FUNC.SLL: return raw === 0 ? "nop" : `sll ${r(rd)}, ${r(rt)}, ${sa}`;
    case FUNC.SRL: return `srl ${r(rd)}, ${r(rt)}, ${sa}`;
    case FUNC.SRA: return `sra ${r(rd)}, ${r(rt)}, ${sa}`;
    case FUNC.SLLV: return `sllv ${r(rd)}, ${r(rt)}, ${r(rs)}`;
    case FUNC.SRLV: return `srlv ${r(rd)}, ${r(rt)}, ${r(rs)}`;
    case FUNC.SRAV: return `srav ${r(rd)}, ${r(rt)}, ${r(rs)}`;
    case FUNC.JR: return `jr ${r(rs)}`;
    case FUNC.JALR: return rd === 31 ? `jalr ${r(rs)}` : `jalr ${r(rd)}, ${r(rs)}`;
    case FUNC.MOVZ: return `movz ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.MOVN: return `movn ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.SYSCALL: return `syscall ${hx((raw >>> 6) & 0xfffff)}`;
    case FUNC.BREAK: return `break ${hx((raw >>> 6) & 0xfffff)}`;
    case FUNC.SYNC: return "sync";
    case FUNC.MFHI: return `mfhi ${r(rd)}`;
    case FUNC.MTHI: return `mthi ${r(rs)}`;
    case FUNC.MFLO: return `mflo ${r(rd)}`;
    case FUNC.MTLO: return `mtlo ${r(rs)}`;
    case FUNC.CLZ: return `clz ${r(rd)}, ${r(rs)}`;
    case FUNC.CLO: return `clo ${r(rd)}, ${r(rs)}`;
    case FUNC.MULT: return `mult ${r(rs)}, ${r(rt)}`;
    case FUNC.MULTU: return `multu ${r(rs)}, ${r(rt)}`;
    case FUNC.DIV: return `div ${r(rs)}, ${r(rt)}`;
    case FUNC.DIVU: return `divu ${r(rs)}, ${r(rt)}`;
    case FUNC.MADD: return `madd ${r(rs)}, ${r(rt)}`;
    case FUNC.MADDU: return `maddu ${r(rs)}, ${r(rt)}`;
    case FUNC.ADD: return `add ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.ADDU: return `addu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.SUB: return `sub ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.SUBU: return `subu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.AND: return `and ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.OR: return `or ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.XOR: return `xor ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.NOR: return `nor ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.SLT: return `slt ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.SLTU: return `sltu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.MAX: return `max ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.MIN: return `min ${r(rd)}, ${r(rs)}, ${r(rt)}`;
    case FUNC.MSUB: return `msub ${r(rs)}, ${r(rt)}`;
    case FUNC.MSUBU: return `msubu ${r(rs)}, ${r(rt)}`;
    default: return `special.${hx(fn)}`;
  }
}

/**
 * Disassemble one instruction. Pass `pc` to show absolute branch/jump targets.
 */
export function disassemble(raw: number, pc?: number): string {
  raw >>>= 0;
  const op = (raw >>> 26) & 0x3f;
  const rs = (raw >>> 21) & 0x1f;
  const rt = (raw >>> 16) & 0x1f;
  const rd = (raw >>> 11) & 0x1f;
  const sa = (raw >>> 6) & 0x1f;
  const uimm = raw & 0xffff;
  const simm = (uimm << 16) >> 16;
  // Branch target is pc-relative to the delay slot (pc + 4); jump target is the
  // 26-bit field shifted, in the current 256MB segment.
  const brTarget = pc !== undefined ? hx((pc + 4 + (simm << 2)) >>> 0) : `${simm}`;
  const jTarget = pc !== undefined
    ? hx((((pc + 4) & 0xf0000000) | ((raw & 0x3ffffff) << 2)) >>> 0)
    : hx((raw & 0x3ffffff) << 2);

  switch (op) {
    case OP.SPECIAL: return disasmSpecial(raw, rs, rt, rd, sa);
    case OP.REGIMM: {
      const sub = rt;
      const name = sub === REGIMM.BLTZ ? "bltz" : sub === REGIMM.BGEZ ? "bgez"
        : sub === REGIMM.BLTZL ? "bltzl" : sub === REGIMM.BGEZL ? "bgezl"
        : sub === REGIMM.BLTZAL ? "bltzal" : sub === REGIMM.BGEZAL ? "bgezal"
        : sub === REGIMM.BLTZALL ? "bltzall" : sub === REGIMM.BGEZALL ? "bgezall" : `regimm.${hx(sub)}`;
      return `${name} ${r(rs)}, ${brTarget}`;
    }
    case OP.J: return `j ${jTarget}`;
    case OP.JAL: return `jal ${jTarget}`;
    case OP.BEQ: return rt === 0 && rs === 0 ? `b ${brTarget}` : `beq ${r(rs)}, ${r(rt)}, ${brTarget}`;
    case OP.BNE: return `bne ${r(rs)}, ${r(rt)}, ${brTarget}`;
    case OP.BLEZ: return `blez ${r(rs)}, ${brTarget}`;
    case OP.BGTZ: return `bgtz ${r(rs)}, ${brTarget}`;
    case OP.ADDI: return `addi ${r(rt)}, ${r(rs)}, ${simm}`;
    case OP.ADDIU: return `addiu ${r(rt)}, ${r(rs)}, ${simm}`;
    case OP.SLTI: return `slti ${r(rt)}, ${r(rs)}, ${simm}`;
    case OP.SLTIU: return `sltiu ${r(rt)}, ${r(rs)}, ${simm}`;
    case OP.ANDI: return `andi ${r(rt)}, ${r(rs)}, ${hx(uimm)}`;
    case OP.ORI: return `ori ${r(rt)}, ${r(rs)}, ${hx(uimm)}`;
    case OP.XORI: return `xori ${r(rt)}, ${r(rs)}, ${hx(uimm)}`;
    case OP.LUI: return `lui ${r(rt)}, ${hx(uimm)}`;
    case OP.COP0: return `cop0 ${hx(raw & 0x1ffffff)}`;
    case OP.COP1: return `cop1 ${hx(raw & 0x1ffffff)}`;
    case OP.COP2: return `cop2 ${hx(raw & 0x1ffffff)}`;
    case OP.BEQL: return `beql ${r(rs)}, ${r(rt)}, ${brTarget}`;
    case OP.BNEL: return `bnel ${r(rs)}, ${r(rt)}, ${brTarget}`;
    case OP.BLEZL: return `blezl ${r(rs)}, ${brTarget}`;
    case OP.BGTZL: return `bgtzl ${r(rs)}, ${brTarget}`;
    case OP.VFPU0: return `vfpu0 ${hx(raw)}`;
    case OP.VFPU1: return `vfpu1 ${hx(raw)}`;
    case OP.VFPU3: return `vfpu3 ${hx(raw)}`;
    case OP.SPECIAL2: return `special2 ${hx(raw & 0x3f)}`; // mfic/mtic/halt — stubbed
    case OP.SPECIAL3: {
      const fn = raw & 0x3f;
      if (fn === FUNC3.EXT) return `ext ${r(rt)}, ${r(rs)}, ${sa}, ${rd + 1}`;
      if (fn === FUNC3.INS) return `ins ${r(rt)}, ${r(rs)}, ${sa}, ${rd - sa + 1}`;
      if (fn === FUNC3.ALLEGREX0 || fn === FUNC3.BSHFL) return `bshfl ${r(rd)}, ${r(rt)}`; // seb/seh/wsbh/bitrev by sa
      if (fn === FUNC3.RDHWR) return `rdhwr ${r(rt)}, ${rd}`;
      return `special3.${hx(fn)}`;
    }
    case OP.LB: return `lb ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LH: return `lh ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LWL: return `lwl ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LW: return `lw ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LBU: return `lbu ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LHU: return `lhu ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LWR: return `lwr ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SB: return `sb ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SH: return `sh ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SWL: return `swl ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SW: return `sw ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SWR: return `swr ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.CACHE: return "cache";
    case OP.LL: return `ll ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.LWC1: return `lwc1 $f${rt}, ${simm}(${r(rs)})`;
    case OP.LVS: return `lv.s $v${rt}, ${simm}(${r(rs)})`;
    case OP.VFPU4: return `vfpu4 ${hx(raw)}`;
    case OP.LV: return `lv ${simm}(${r(rs)})`;
    case OP.LVQ: return `lv.q ${simm}(${r(rs)})`;
    case OP.VFPU5: return `vfpu5 ${hx(raw)}`;
    case OP.SC: return `sc ${r(rt)}, ${simm}(${r(rs)})`;
    case OP.SWC1: return `swc1 $f${rt}, ${simm}(${r(rs)})`;
    case OP.SVS: return `sv.s $v${rt}, ${simm}(${r(rs)})`;
    case OP.VFPU6: return `vfpu6 ${hx(raw)}`;
    case OP.SV: return `sv ${simm}(${r(rs)})`;
    case OP.SVQ: return `sv.q ${simm}(${r(rs)})`;
    case OP.VFLUSH: return "vflush";
    default: return `op.${hx(op)} ${hx(raw)}`;
  }
}
