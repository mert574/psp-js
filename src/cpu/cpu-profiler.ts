/**
 * Interpreter profiler — answers "where does the MIPS interpreter time go".
 *
 * Two cheap, gated measurements:
 *  1. Instruction-mix histogram: counts every executed instruction by class
 *     (load, store, alu, branch, jump, mul/div, fpu, vfpu, syscall, ...). Shows
 *     the workload character, so we know which handlers to speed up.
 *  2. Hot-PC sampling: every Nth instruction records the PC, building a
 *     statistical profile of the hottest game loops (the JIT/block-compile
 *     candidates). Each hot PC also keeps the class seen there.
 *
 * The CPU only calls tick() when cpu.profiler is non-null, so a normal run pays
 * nothing. Counts are exact regardless of the small slowdown profiling adds, so
 * the mix proportions stay trustworthy; measure the interpreter's total ms with
 * the profiler OFF (the frontend [PERF] report) and the mix with it ON.
 */

import { disassemble } from "./disasm.js";
import { OP, FUNC } from "./opcodes.js";

// Instruction classes. Index order is the report order.
export const CPU_CLASS_NAMES = [
  "other", "load", "store", "aluImm", "aluReg",
  "mulDiv", "branch", "jump", "fpu", "vfpu", "syscall",
] as const;
const OTHER = 0, LOAD = 1, STORE = 2, ALU_IMM = 3, ALU_REG = 4,
  MUL_DIV = 5, BRANCH = 6, JUMP = 7, FPU = 8, VFPU = 9, SYSCALL = 10;
const NUM_CLASSES = CPU_CLASS_NAMES.length;

/** Class of each primary opcode (op = raw >>> 26). Mirrors executor.ts dispatch. */
const PRIM_CLASS = ((): Uint8Array => {
  const t = new Uint8Array(64).fill(OTHER);
  t[OP.REGIMM] = BRANCH;                                          // bltz/bgez
  t[OP.J] = JUMP; t[OP.JAL] = JUMP;
  t[OP.BEQ] = t[OP.BNE] = t[OP.BLEZ] = t[OP.BGTZ] = BRANCH;
  t[OP.ADDI] = t[OP.ADDIU] = t[OP.SLTI] = t[OP.SLTIU] = ALU_IMM;
  t[OP.ANDI] = t[OP.ORI] = t[OP.XORI] = t[OP.LUI] = ALU_IMM;
  t[OP.COP0] = SYSCALL;                                           // system
  t[OP.COP1] = FPU;
  t[OP.COP2] = VFPU;
  t[OP.BEQL] = t[OP.BNEL] = t[OP.BLEZL] = t[OP.BGTZL] = BRANCH;
  t[OP.VFPU0] = t[OP.VFPU1] = t[OP.VFPU3] = VFPU;
  // OP.SPECIAL2 (0x1c) is mfic/mtic/halt (stubbed), left OTHER.
  t[OP.SPECIAL3] = ALU_REG;                                       // ext/ins/seb/...
  t[OP.LB] = t[OP.LH] = t[OP.LWL] = t[OP.LW] = t[OP.LBU] = t[OP.LHU] = t[OP.LWR] = LOAD;
  t[OP.SB] = t[OP.SH] = t[OP.SWL] = t[OP.SW] = t[OP.SWR] = STORE;
  t[OP.LL] = t[OP.LWC1] = t[OP.LVS] = t[OP.LV] = t[OP.LVQ] = LOAD;
  t[OP.VFPU4] = t[OP.VFPU5] = t[OP.VFPU6] = VFPU;
  t[OP.SC] = t[OP.SWC1] = t[OP.SVS] = t[OP.SV] = t[OP.SVQ] = STORE;
  return t;
})();

/** Class of each SPECIAL (op 0) funct. Most are register ALU ops. */
const SPECIAL_CLASS = ((): Uint8Array => {
  const t = new Uint8Array(64).fill(ALU_REG);
  t[FUNC.JR] = JUMP; t[FUNC.JALR] = JUMP;
  t[FUNC.SYSCALL] = SYSCALL; t[FUNC.BREAK] = SYSCALL; t[FUNC.SYNC] = SYSCALL;
  t[FUNC.MULT] = t[FUNC.MULTU] = t[FUNC.DIV] = t[FUNC.DIVU] = MUL_DIV;
  t[FUNC.MADD] = t[FUNC.MADDU] = t[FUNC.MSUB] = t[FUNC.MSUBU] = MUL_DIV;
  return t;
})();

export class CpuProfiler {
  /** Per-class execution counts (exact). */
  readonly classCounts = new Uint32Array(NUM_CLASSES);
  /** Total instructions counted. */
  total = 0;

  // Hot-PC statistical sampling. Sample one in (mask+1) instructions; hot loops
  // concentrate, so the map stays small. pcClass keeps the class seen at each PC.
  private readonly sampleMask: number;
  private tickCount = 0;
  readonly pcSamples = new Map<number, number>();
  private readonly pcClass = new Map<number, number>();
  private readonly pcRaw = new Map<number, number>(); // raw word seen at each sampled PC, for disassembly
  pcSampleTotal = 0;

  /** sampleEvery rounds up to a power of two (default 64). */
  constructor(sampleEvery = 64) {
    let n = 1;
    while (n < sampleEvery) n <<= 1;
    this.sampleMask = n - 1;
  }

  /** Called once per executed instruction when profiling is on. */
  tick(op: number, funct: number, pc: number, raw: number): void {
    const cls = op === 0 ? SPECIAL_CLASS[funct]! : PRIM_CLASS[op]!;
    this.classCounts[cls] = this.classCounts[cls]! + 1;
    this.total++;
    if ((this.tickCount++ & this.sampleMask) === 0) {
      this.pcSamples.set(pc, (this.pcSamples.get(pc) ?? 0) + 1);
      if (!this.pcClass.has(pc)) { this.pcClass.set(pc, cls); this.pcRaw.set(pc, raw); }
      this.pcSampleTotal++;
    }
  }

  reset(): void {
    this.classCounts.fill(0);
    this.total = 0;
    this.tickCount = 0;
    this.pcSamples.clear();
    this.pcClass.clear();
    this.pcRaw.clear();
    this.pcSampleTotal = 0;
  }

  /** Instruction mix, sorted by count (descending), with percentages. */
  classBreakdown(): { name: string; count: number; pct: number }[] {
    const out: { name: string; count: number; pct: number }[] = [];
    for (let i = 0; i < NUM_CLASSES; i++) {
      const count = this.classCounts[i]!;
      if (count === 0) continue;
      out.push({ name: CPU_CLASS_NAMES[i]!, count, pct: this.total ? (100 * count) / this.total : 0 });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  /** The n hottest sampled PCs (descending), with class, disassembly, and percentage. */
  topPcs(n = 20): { pc: string; cls: string; asm: string; samples: number; pct: number }[] {
    const entries = [...this.pcSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    return entries.map(([pc, samples]) => ({
      pc: "0x" + (pc >>> 0).toString(16),
      cls: CPU_CLASS_NAMES[this.pcClass.get(pc) ?? OTHER]!,
      asm: disassemble(this.pcRaw.get(pc) ?? 0, pc),
      samples,
      pct: this.pcSampleTotal ? (100 * samples) / this.pcSampleTotal : 0,
    }));
  }

  /** Print the instruction mix and hot-PC tables to the console. */
  report(topN = 20): void {
    const mix = this.classBreakdown();
    console.log(`[CPUPROF] ${this.total.toLocaleString()} instructions, ${this.pcSampleTotal.toLocaleString()} PC samples (1/${this.sampleMask + 1})`);
    console.log("[CPUPROF] instruction mix by class:");
    console.table(mix.map(r => ({ class: r.name, count: r.count, pct: +r.pct.toFixed(1) })));
    console.log(`[CPUPROF] top ${topN} hot PCs:`);
    console.table(this.topPcs(topN).map(r => ({ pc: r.pc, asm: r.asm, class: r.cls, samples: r.samples, pct: +r.pct.toFixed(1) })));
  }
}
