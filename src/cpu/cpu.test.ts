import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBus } from "../memory/memory-bus.js";
import { AllegrexCPU } from "./cpu.js";
import { MemoryRegion } from "../memory/memory-map.js";

const RAM = MemoryRegion.RAM_START;

/** Write a program (array of 32-bit words) into RAM and set PC there. */
function loadProgram(cpu: AllegrexCPU, words: number[]): void {
  for (let i = 0; i < words.length; i++) {
    cpu.bus.writeU32(RAM + i * 4, words[i]!);
  }
  cpu.regs.pc = RAM;
}

function makeWord(op: number, rs: number, rt: number, rd: number, shamt: number, funct: number): number {
  return ((op & 0x3f) << 26 | (rs & 0x1f) << 21 | (rt & 0x1f) << 16 |
          (rd & 0x1f) << 11 | (shamt & 0x1f) << 6 | (funct & 0x3f)) >>> 0;
}
function makeI(op: number, rs: number, rt: number, imm: number): number {
  return ((op & 0x3f) << 26 | (rs & 0x1f) << 21 | (rt & 0x1f) << 16 |
          (imm & 0xffff)) >>> 0;
}

// Opcode constants
const SPECIAL = 0x00;
const ADDU  = 0x21; // funct
const SUBU  = 0x23;
const AND   = 0x24;
const OR    = 0x25;
const XOR   = 0x26;
const NOR   = 0x27;
const SLT   = 0x2a;
const SLTU  = 0x2b;
const SLL   = 0x00;
const SRL   = 0x02;
const SRA   = 0x03;
const JR    = 0x08;
const MFLO  = 0x12;
const MULTU_FUNCT = 0x19;
const ADDIU = 0x09;
const ORI   = 0x0d;
const LUI   = 0x0f;
const LW    = 0x23;
const SW    = 0x2b;
const BEQ   = 0x04;
const BNE   = 0x05;

describe("AllegrexCPU — ALU instructions", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("ADDU: r3 = r1 + r2", () => {
    cpu.regs.setGpr(1, 10);
    cpu.regs.setGpr(2, 32);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, ADDU)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(42);
  });

  it("SUBU: r3 = r1 - r2", () => {
    cpu.regs.setGpr(1, 100);
    cpu.regs.setGpr(2, 58);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, SUBU)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(42);
  });

  it("AND: r3 = r1 & r2", () => {
    cpu.regs.setGpr(1, 0xff);
    cpu.regs.setGpr(2, 0x0f);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, AND)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0x0f);
  });

  it("OR: r3 = r1 | r2", () => {
    cpu.regs.setGpr(1, 0xf0);
    cpu.regs.setGpr(2, 0x0f);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, OR)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0xff);
  });

  it("XOR: r3 = r1 ^ r2", () => {
    cpu.regs.setGpr(1, 0xff);
    cpu.regs.setGpr(2, 0x0f);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, XOR)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0xf0);
  });

  it("NOR: r3 = ~(r1 | r2)", () => {
    cpu.regs.setGpr(1, 0);
    cpu.regs.setGpr(2, 0);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, NOR)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0xffffffff);
  });

  it("SLT: signed comparison", () => {
    cpu.regs.setGpr(1, 0xffffffff); // -1 signed
    cpu.regs.setGpr(2, 1);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, SLT)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(1); // -1 < 1
  });

  it("SLTU: unsigned comparison", () => {
    cpu.regs.setGpr(1, 1);
    cpu.regs.setGpr(2, 0xffffffff);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, SLTU)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(1); // 1 < 0xffffffff (unsigned)
  });

  it("SLL: shift left by 2", () => {
    cpu.regs.setGpr(2, 1);
    loadProgram(cpu, [makeWord(SPECIAL, 0, 2, 3, 2, SLL)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(4);
  });

  it("SRL: logical shift right by 1", () => {
    cpu.regs.setGpr(2, 0x80000000);
    loadProgram(cpu, [makeWord(SPECIAL, 0, 2, 3, 1, SRL)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0x40000000);
  });

  it("SRA: arithmetic shift right preserves sign", () => {
    cpu.regs.setGpr(2, 0x80000000);
    loadProgram(cpu, [makeWord(SPECIAL, 0, 2, 3, 1, SRA)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(0xc0000000);
  });

  it("r0 is always 0 — writes are silently dropped", () => {
    loadProgram(cpu, [makeI(ADDIU, 0, 0, 99)]);
    cpu.step();
    expect(cpu.regs.getGpr(0)).toBe(0);
  });
});

describe("AllegrexCPU — immediate instructions", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("ADDIU: r2 = r1 + imm", () => {
    cpu.regs.setGpr(1, 40);
    loadProgram(cpu, [makeI(ADDIU, 1, 2, 2)]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(42);
  });

  it("ADDIU: sign-extends negative immediate", () => {
    cpu.regs.setGpr(1, 100);
    loadProgram(cpu, [makeI(ADDIU, 1, 2, 0xffff)]); // -1 sign-extended
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(99);
  });

  it("ORI: r2 = r1 | imm (zero-extended)", () => {
    cpu.regs.setGpr(1, 0x00ff0000);
    loadProgram(cpu, [makeI(ORI, 1, 2, 0x00ff)]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0x00ff00ff);
  });

  it("LUI: loads upper 16 bits", () => {
    loadProgram(cpu, [makeI(LUI, 0, 2, 0xdead)]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0xdead0000);
  });
});

describe("AllegrexCPU — load/store", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("SW + LW round-trip", () => {
    // Use RAM+100 as data address — well past the 2-instruction program at RAM+0..RAM+7
    cpu.regs.setGpr(1, RAM + 100);
    cpu.regs.setGpr(2, 0xdeadbeef);
    loadProgram(cpu, [
      makeI(SW, 1, 2, 0),          // sw r2, 0(r1)   → store 0xdeadbeef at RAM+100
      makeI(LW, 1, 3, 0),          // lw r3, 0(r1)   → load it back into r3
    ]);
    cpu.step(); // SW
    cpu.step(); // LW
    expect(cpu.regs.getGpr(3)).toBe(0xdeadbeef);
  });
});

describe("AllegrexCPU — multiply", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("MULTU + MFLO: 6 * 7 = 42", () => {
    cpu.regs.setGpr(1, 6);
    cpu.regs.setGpr(2, 7);
    loadProgram(cpu, [
      makeWord(SPECIAL, 1, 2, 0, 0, MULTU_FUNCT), // multu r1, r2
      makeWord(SPECIAL, 0, 0, 3, 0, MFLO),         // mflo  r3
    ]);
    cpu.step(); cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(42);
  });
});

describe("AllegrexCPU — LL/SC", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("LL loads a word from memory", () => {
    const addr = RAM + 100;
    cpu.bus.writeU32(addr, 0xcafebabe);
    cpu.regs.setGpr(1, addr);
    // LL rt=2, offset=0, base=r1 → opcode 0x30
    loadProgram(cpu, [makeI(0x30, 1, 2, 0)]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0xcafebabe);
  });

  it("SC stores a word and sets rt=1", () => {
    const addr = RAM + 100;
    cpu.regs.setGpr(1, addr);
    cpu.regs.setGpr(2, 0xdeadbeef);
    // SC rt=2, offset=0, base=r1 → opcode 0x38
    loadProgram(cpu, [makeI(0x38, 1, 2, 0)]);
    cpu.step();
    expect(cpu.bus.readU32(addr)).toBe(0xdeadbeef);
    expect(cpu.regs.getGpr(2)).toBe(1); // SC always succeeds
  });
});

describe("AllegrexCPU — MOVZ/MOVN", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("MOVZ: rd=rs when rt==0", () => {
    cpu.regs.setGpr(1, 42);
    cpu.regs.setGpr(2, 0); // condition: rt==0
    cpu.regs.setGpr(3, 99);
    // MOVZ rd=3, rs=1, rt=2 → SPECIAL funct=0x0a
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, 0x0a)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(42);
  });

  it("MOVZ: rd unchanged when rt!=0", () => {
    cpu.regs.setGpr(1, 42);
    cpu.regs.setGpr(2, 1);
    cpu.regs.setGpr(3, 99);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, 0x0a)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(99);
  });

  it("MOVN: rd=rs when rt!=0", () => {
    cpu.regs.setGpr(1, 42);
    cpu.regs.setGpr(2, 1);
    cpu.regs.setGpr(3, 99);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, 0x0b)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(42);
  });

  it("MOVN: rd unchanged when rt==0", () => {
    cpu.regs.setGpr(1, 42);
    cpu.regs.setGpr(2, 0);
    cpu.regs.setGpr(3, 99);
    loadProgram(cpu, [makeWord(SPECIAL, 1, 2, 3, 0, 0x0b)]);
    cpu.step();
    expect(cpu.regs.getGpr(3)).toBe(99);
  });
});

describe("AllegrexCPU — FPU (COP1)", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("MTC1 + MFC1 round-trip", () => {
    cpu.regs.setGpr(1, 0x40490fdb); // π as f32 bits
    // MTC1 rt=1, fs=0 → COP1(0x11) rs=0x04, rt=1, rd=0
    const mtc1 = ((0x11 << 26) | (0x04 << 21) | (1 << 16) | (0 << 11)) >>> 0;
    // MFC1 rt=2, fs=0 → COP1(0x11) rs=0x00, rt=2, rd=0
    const mfc1 = ((0x11 << 26) | (0x00 << 21) | (2 << 16) | (0 << 11)) >>> 0;
    loadProgram(cpu, [mtc1, mfc1]);
    cpu.step(); cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0x40490fdb);
  });

  it("ADD.S: f2 = f0 + f1", () => {
    cpu.regs.setFpr(0, 1.5);
    cpu.regs.setFpr(1, 2.5);
    // ADD.S fd=2, fs=0, ft=1 → COP1 fmt=0x10, funct=0x00
    // encoding: 0x11<<26 | 0x10<<21 | ft<<16 | fs<<11 | fd<<6 | funct
    const add_s = ((0x11 << 26) | (0x10 << 21) | (1 << 16) | (0 << 11) | (2 << 6) | 0x00) >>> 0;
    loadProgram(cpu, [add_s]);
    cpu.step();
    expect(cpu.regs.getFpr(2)).toBeCloseTo(4.0);
  });

  it("MUL.S: f2 = f0 * f1", () => {
    cpu.regs.setFpr(0, 3.0);
    cpu.regs.setFpr(1, 7.0);
    const mul_s = ((0x11 << 26) | (0x10 << 21) | (1 << 16) | (0 << 11) | (2 << 6) | 0x02) >>> 0;
    loadProgram(cpu, [mul_s]);
    cpu.step();
    expect(cpu.regs.getFpr(2)).toBeCloseTo(21.0);
  });

  it("CVT.W.S truncates float to int in FPR", () => {
    cpu.regs.setFpr(0, 3.7);
    // CVT.W.S fd=1, fs=0 → COP1 fmt=0x10, funct=0x24
    const cvt = ((0x11 << 26) | (0x10 << 21) | (0 << 16) | (0 << 11) | (1 << 6) | 0x24) >>> 0;
    loadProgram(cpu, [cvt]);
    cpu.step();
    expect(cpu.regs.getFprBits(1)).toBe(3); // truncated to int
  });

  it("LWC1 + SWC1 round-trip", () => {
    const addr = RAM + 100;
    cpu.bus.writeU32(addr, 0x40490fdb); // π bits
    cpu.regs.setGpr(1, addr);
    // LWC1 ft=0, base=r1, offset=0 → opcode 0x31
    const lwc1 = ((0x31 << 26) | (1 << 21) | (0 << 16) | 0) >>> 0;
    // SWC1 ft=0, base=r1, offset=4 → opcode 0x39
    const swc1 = ((0x39 << 26) | (1 << 21) | (0 << 16) | 4) >>> 0;
    loadProgram(cpu, [lwc1, swc1]);
    cpu.step(); cpu.step();
    expect(cpu.bus.readU32(addr + 4)).toBe(0x40490fdb);
  });
});

describe("AllegrexCPU — VFPU", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("LV.S loads float into VFPU register", () => {
    const addr = RAM + 100;
    // Write 42.0 as f32 bits
    const f32buf = new Float32Array(1);
    f32buf[0] = 42.0;
    const bits = new Uint32Array(f32buf.buffer)[0]!;
    cpu.bus.writeU32(addr, bits);
    cpu.regs.setGpr(1, addr);
    // LV.S vt=0, base=r1, offset=0 → opcode 0x32, rt=0 (vt low), bits 1:0=0 (vt high)
    const lvs = ((0x32 << 26) | (1 << 21) | (0 << 16) | 0) >>> 0;
    loadProgram(cpu, [lvs]);
    cpu.step();
    expect(cpu.regs.vfpr[0]).toBeCloseTo(42.0);
  });

  it("SV.S stores VFPU register to memory", () => {
    const addr = RAM + 100;
    cpu.regs.vfpr[0] = 42.0;
    cpu.regs.setGpr(1, addr);
    // SV.S vt=0, base=r1, offset=0 → opcode 0x3a
    const svs = ((0x3a << 26) | (1 << 21) | (0 << 16) | 0) >>> 0;
    loadProgram(cpu, [svs]);
    cpu.step();
    // Read back as float
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, cpu.bus.readU32(addr), true);
    expect(view.getFloat32(0, true)).toBeCloseTo(42.0);
  });
});

describe("AllegrexCPU — SPECIAL2 (CLZ, MADD)", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("CLZ: count leading zeros of 0x00FF0000 = 8", () => {
    cpu.regs.setGpr(1, 0x00FF0000);
    // CLZ rd=2, rs=1 → SPECIAL2(0x1c) funct=0x20
    const clz = ((0x1c << 26) | (1 << 21) | (0 << 16) | (2 << 11) | 0x20) >>> 0;
    loadProgram(cpu, [clz]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(8);
  });

  it("CLZ of 0 = 32", () => {
    cpu.regs.setGpr(1, 0);
    const clz = ((0x1c << 26) | (1 << 21) | (0 << 16) | (2 << 11) | 0x20) >>> 0;
    loadProgram(cpu, [clz]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(32);
  });
});

describe("AllegrexCPU — SPECIAL3 (EXT, INS)", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("EXT: extract bits 4-7 from 0xFF", () => {
    cpu.regs.setGpr(1, 0xFF);
    // EXT rt=2, rs=1, pos=4, size=4 → rd=pos+size-1=7, shamt=pos=4, funct=0x00
    const ext = ((0x1f << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (4 << 6) | 0x00) >>> 0;
    loadProgram(cpu, [ext]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0x0F); // bits 4-7 of 0xFF = 0xF
  });

  it("INS: insert bits", () => {
    cpu.regs.setGpr(1, 0xA);  // value to insert
    cpu.regs.setGpr(2, 0xFF); // destination
    // INS rt=2, rs=1, pos=4, size=4 → rd=pos+size-1=7, shamt=pos=4, funct=0x04
    const ins = ((0x1f << 26) | (1 << 21) | (2 << 16) | (7 << 11) | (4 << 6) | 0x04) >>> 0;
    loadProgram(cpu, [ins]);
    cpu.step();
    expect(cpu.regs.getGpr(2)).toBe(0xAF); // bits 4-7 replaced with 0xA
  });
});

describe("AllegrexCPU — branches", () => {
  let cpu: AllegrexCPU;

  beforeEach(() => {
    cpu = new AllegrexCPU(new MemoryBus());
  });

  it("BEQ taken: jumps over second instruction", () => {
    cpu.regs.setGpr(1, 5);
    cpu.regs.setGpr(2, 5);
    // BEQ at RAM+0: target = (RAM+4) + (offset<<2) = RAM+4 + 8 = RAM+12 → instr[3]
    loadProgram(cpu, [
      makeI(BEQ, 1, 2, 2),          // beq r1, r2, +2  (branch to RAM+12)
      makeI(ADDIU, 0, 3, 99),        // delay slot (should execute)
      makeI(ADDIU, 0, 4, 77),        // skipped
      makeI(ADDIU, 0, 5, 55),        // branch target
    ]);
    cpu.step(); // BEQ
    cpu.step(); // delay slot (ADDIU r3=99)
    // Now PC should be at instruction index 3
    cpu.step(); // target instruction (ADDIU r5=55)
    expect(cpu.regs.getGpr(3)).toBe(99); // delay slot ran
    expect(cpu.regs.getGpr(4)).toBe(0);  // skipped
    expect(cpu.regs.getGpr(5)).toBe(55); // branch target ran
  });

  it("BNE not taken: falls through", () => {
    cpu.regs.setGpr(1, 5);
    cpu.regs.setGpr(2, 5);
    loadProgram(cpu, [
      makeI(BNE, 1, 2, 5),           // not taken (r1 == r2)
      makeI(ADDIU, 0, 3, 42),        // falls through to here (delay slot)
    ]);
    cpu.step(); // BNE
    cpu.step(); // next instruction
    expect(cpu.regs.getGpr(3)).toBe(42);
  });
});
