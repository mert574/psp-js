/**
 * MIPS Allegrex opcode constants — named values for the primary opcode (bits
 * 31-26) and the function fields of SPECIAL / SPECIAL2 / SPECIAL3 / REGIMM.
 *
 * Use these instead of raw hex when matching instructions (disassembler,
 * profiler classification). Mirrors the dispatch in executor.ts.
 */

/** Primary opcode = (raw >>> 26) & 0x3f. Values verified against PPSSPP
 *  MIPSTables.cpp and executor.ts. Op 0x1a is the emulator-internal "Emu"
 *  opcode (not a real instruction), and 0x1d/0x1e/0x33/0x3b are invalid, so
 *  there is no VFPU2 here. */
export const OP = {
  SPECIAL: 0x00, REGIMM: 0x01, J: 0x02, JAL: 0x03,
  BEQ: 0x04, BNE: 0x05, BLEZ: 0x06, BGTZ: 0x07,
  ADDI: 0x08, ADDIU: 0x09, SLTI: 0x0a, SLTIU: 0x0b,
  ANDI: 0x0c, ORI: 0x0d, XORI: 0x0e, LUI: 0x0f,
  COP0: 0x10, COP1: 0x11, COP2: 0x12,
  BEQL: 0x14, BNEL: 0x15, BLEZL: 0x16, BGTZL: 0x17,
  VFPU0: 0x18, VFPU1: 0x19, VFPU3: 0x1b,
  SPECIAL2: 0x1c, SPECIAL3: 0x1f,
  LB: 0x20, LH: 0x21, LWL: 0x22, LW: 0x23, LBU: 0x24, LHU: 0x25, LWR: 0x26,
  SB: 0x28, SH: 0x29, SWL: 0x2a, SW: 0x2b, SWR: 0x2e, CACHE: 0x2f,
  LL: 0x30, LWC1: 0x31, LVS: 0x32, VFPU4: 0x34, LV: 0x35, LVQ: 0x36, VFPU5: 0x37,
  SC: 0x38, SWC1: 0x39, SVS: 0x3a, VFPU6: 0x3c, SV: 0x3d, SVQ: 0x3e, VFLUSH: 0x3f,
} as const;

/** SPECIAL (op 0) function = raw & 0x3f. Allegrex keeps CLZ/CLO and the
 *  multiply-accumulate + MAX/MIN ops here (not in SPECIAL2). */
export const FUNC = {
  SLL: 0x00, SRL: 0x02, SRA: 0x03, SLLV: 0x04, SRLV: 0x06, SRAV: 0x07,
  JR: 0x08, JALR: 0x09, MOVZ: 0x0a, MOVN: 0x0b,
  SYSCALL: 0x0c, BREAK: 0x0d, SYNC: 0x0f,
  MFHI: 0x10, MTHI: 0x11, MFLO: 0x12, MTLO: 0x13,
  CLZ: 0x16, CLO: 0x17,
  MULT: 0x18, MULTU: 0x19, DIV: 0x1a, DIVU: 0x1b, MADD: 0x1c, MADDU: 0x1d,
  ADD: 0x20, ADDU: 0x21, SUB: 0x22, SUBU: 0x23,
  AND: 0x24, OR: 0x25, XOR: 0x26, NOR: 0x27,
  SLT: 0x2a, SLTU: 0x2b, MAX: 0x2c, MIN: 0x2d, MSUB: 0x2e, MSUBU: 0x2f,
} as const;

/** REGIMM (op 1) sub-op = rt field. */
export const REGIMM = {
  BLTZ: 0x00, BGEZ: 0x01, BLTZL: 0x02, BGEZL: 0x03,
  BLTZAL: 0x10, BGEZAL: 0x11, BLTZALL: 0x12, BGEZALL: 0x13,
} as const;

/** SPECIAL3 (op 0x1f) function = raw & 0x3f. The 0x18/0x20 group (ALLEGREX0)
 *  selects SEB/SEH/WSBH/WSBW/BITREV by the shamt field. */
export const FUNC3 = { EXT: 0x00, INS: 0x04, ALLEGREX0: 0x18, BSHFL: 0x20, RDHWR: 0x3b } as const;

/** Coprocessor sub-op = rs field (bits 25-21), shared by COP0/COP1/COP2.
 *  MFV/MTV (0x03/0x07) are the VFPU register moves on COP2; CO (0x10) is the
 *  COP0 coprocessor-operation class (ERET). Verified vs PPSSPP tableCop1. */
export const COP = {
  MFC: 0x00, CFC: 0x02, MFV: 0x03, MTC: 0x04, CTC: 0x06, MTV: 0x07, BC: 0x08, CO: 0x10,
} as const;

/** COP1 float format = rs field when the op is a computation (not a move). */
export const FMT = { S: 0x10, D: 0x11, W: 0x14 } as const;

/** COP1 (FPU) function = raw & 0x3f. C.cond compares occupy 0x30-0x3f. */
export const FPU = {
  ADD: 0x00, SUB: 0x01, MUL: 0x02, DIV: 0x03, SQRT: 0x04, ABS: 0x05, MOV: 0x06, NEG: 0x07,
  ROUND_W: 0x0c, TRUNC_W: 0x0d, CEIL_W: 0x0e, FLOOR_W: 0x0f, CVT_S: 0x20, CVT_W: 0x24,
} as const;

/** COP0 system-control register number = rd field. */
export const CP0 = { STATUS: 12, CAUSE: 13, EPC: 14 } as const;

/** COP0 coprocessor-operation function (rs = COP.CO) = raw & 0x3f. */
export const COP0_FN = { ERET: 0x18 } as const;

/** SPECIAL3 ALLEGREX0/BSHFL sub-op = shamt field (bits 10-6). */
export const BSHFL = { WSBH: 2, WSBW: 3, SEB: 16, BITREV: 20, SEH: 24 } as const;

// ── VFPU instruction tables ──────────────────────────────────────────────
// Each VFPU primary group decodes a sub-op from a different field, and the
// values repeat across groups (vadd, vmul, vcmp are all 0), so each table is
// its own object. Values mirror executor.ts; do NOT merge them.

/** VFPU0 (op 0x18) sub-op = (raw >>> 23) & 7. */
export const VFPU0_OP = { VADD: 0, VSUB: 1, VSBN: 2, VDIV: 7 } as const;

/** VFPU1 (op 0x19) sub-op = (raw >>> 23) & 7. */
export const VFPU1_OP = { VMUL: 0, VDOT: 1, VSCL: 2, VHDP: 4, VCRS: 5, VDET: 6 } as const;

/** VFPU3 (op 0x1b) sub-op = (raw >>> 23) & 7. The compare condition lives in a
 *  separate field (raw & 0xF) and is NOT an opcode. */
export const VFPU3_OP = { VCMP: 0, VMIN: 2, VMAX: 3, VSCMP: 5, VSGE: 6, VSLT: 7 } as const;

/** VFPU4Jump (op 0x34) float-to-int variants = rs field. */
export const VF2I = { VF2IN: 16, VF2IZ: 17, VF2IU: 18, VF2ID: 19 } as const;

/** VFPU4Jump rs=0 single-arg table = rt field. */
export const VFPU4_OP = {
  VMOV: 0, VABS: 1, VNEG: 2, VIDT: 3, VSAT0: 4, VSAT1: 5, VZERO: 6, VONE: 7,
  VRCP: 16, VRSQ: 17, VSIN: 18, VCOS: 19, VEXP2: 20, VLOG2: 21, VSQRT: 22,
  VASIN: 23, VNRCP: 24, VNSIN: 26, VREXP2: 28,
} as const;

/** VFPU4Jump rs=1 int/half conversion table = rt field. */
export const VFPU7_OP = {
  VF2H: 18, VH2F: 19, VUC2I: 24, VC2I: 25, VUS2I: 26, VS2I: 27,
  VI2UC: 28, VI2C: 29, VI2US: 30, VI2S: 31,
} as const;

/** VFPU4Jump rs=2 utility table = rt field. The color-convert format (1/2/3)
 *  is an operand, not an opcode. */
export const VFPU9_OP = {
  VSRT1: 0, VSRT2: 1, VBFY1: 2, VBFY2: 3, VOCP: 4, VSOCP: 5, VFAD: 6, VAVG: 7,
  VSRT3: 8, VSRT4: 9, VSGN: 10, VMFVC: 16, VMTVC: 17, VT4444: 25, VT5551: 26, VT5650: 27,
} as const;

/** VFPU6 (op 0x3c) matrix-init sub-table (sub5=28) = rt field. */
export const VFPU6_OP = { VMMOV: 0, VMIDT: 3, VMZERO: 6, VMONE: 7 } as const;
