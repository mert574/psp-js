/**
 * Profile gow-sparta: per-frame wall time + a PC histogram (where CPU cycles go)
 * + a syscall histogram. Finds the hot path behind the 1-6 fps drop.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;

// PC histogram bucketed to 64-byte regions (coarse function granularity).
const pcHist = new Map<number, number>();
let sampleN = 0;
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  if ((sampleN++ & 0x3f) === 0) { // sample every 64 steps
    const region = (cpu.regs.pc >>> 0) & ~0x3f;
    pcHist.set(region, (pcHist.get(region) ?? 0) + 1);
  }
  return origStep();
};

// Syscall histogram
const sysHist = new Map<string, number>();
const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code, regs, bus) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `code${code}`;
  sysHist.set(name, (sysHist.get(name) ?? 0) + 1);
  return origDispatch(code, regs, bus);
};

const FRAMES = parseInt(process.argv[2] ?? "120", 10);
const frameMs: number[] = [];
for (let f = 0; f < FRAMES; f++) {
  const t0 = performance.now();
  emu.runFrame();
  frameMs.push(performance.now() - t0);
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`HALT/FAULT at frame ${f} pc=0x${cpu.regs.pc.toString(16)}`); break; }
}

console.log("\n== per-frame ms (every 10th) ==");
for (let i = 0; i < frameMs.length; i += 10) {
  console.log(`  f${i}: ${frameMs[i]!.toFixed(1)}ms`);
}
const slow = frameMs.filter(m => m > 50).length;
console.log(`frames >50ms: ${slow}/${frameMs.length}`);

console.log("\n== top PC regions (×64 steps each) ==");
const top = [...pcHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [region, n] of top) {
  console.log(`  0x${region.toString(16)}: ${n}`);
}

console.log("\n== top syscalls ==");
const sys = [...sysHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [name, n] of sys) console.log(`  ${name}: ${n}`);
