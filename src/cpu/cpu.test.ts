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
