/**
 * Investigate gow's splash-screen spin: recover past the frame-15 null-vtable
 * fault (investigation hack), reach steady state, then trace the dominant loop —
 * which syscalls, their returns, and whether async-read STREAMING makes progress
 * (file position advancing) vs is stuck.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;

// Recover past the known null-call fault so we can observe steady state.
const origStep = cpu.step.bind(cpu);
let recoveries = 0;
cpu.step = () => {
  if ((cpu.regs.pc >>> 0) === 0) {
    cpu.regs.pc = cpu.regs.gpr[31]! >>> 0; // jump to $ra, skip the bad call
    recoveries++;
  }
  return origStep();
};

interface Stat { count: number; rets: Map<number, number>; sampleArgs: string }
const sys = new Map<string, Stat>();
// Track async-read streaming progress per fd.
const readProgress = new Map<number, { reads: number; totalBytes: number; lastPos: number }>();
let trace = false;

const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code, regs, bus) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `code${code}`;
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0;
  origDispatch(code, regs, bus);
  if (!trace) return;
  const ret = regs.getGpr(2) >>> 0;
  let s = sys.get(name);
  if (!s) { s = { count: 0, rets: new Map(), sampleArgs: `${a0.toString(16)},${a1.toString(16)},${a2.toString(16)}` }; sys.set(name, s); }
  s.count++;
  s.rets.set(ret, (s.rets.get(ret) ?? 0) + 1);
  if (name === "sceIoReadAsync") {
    const p = readProgress.get(a0) ?? { reads: 0, totalBytes: 0, lastPos: -1 };
    p.reads++; p.totalBytes += a2; readProgress.set(a0, p);
  }
};

// Boot to steady state, then trace one frame's worth.
for (let f = 0; f < 40; f++) { emu.runFrame(); }
trace = true;
for (let f = 0; f < 3; f++) { emu.runFrame(); }

console.log(`RESULT recoveries(null-call skips): ${recoveries}`);
console.log(`RESULT pc=0x${cpu.regs.pc.toString(16)} tid=${kernel.currentThreadId}`);
console.log("RESULT syscalls over 3 frames (name count [ret×n ...]):");
for (const [name, s] of [...sys.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 18)) {
  const rets = [...s.rets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([r, n]) => `0x${r.toString(16)}×${n}`).join(" ");
  console.log(`  ${name}: ${s.count}  rets[${rets}]  args(${s.sampleArgs})`);
}
console.log("RESULT async-read streaming progress (fd → reads, MB):");
for (const [fd, p] of readProgress) {
  console.log(`  fd=0x${fd.toString(16)}: ${p.reads} reads, ${(p.totalBytes / 1048576).toFixed(2)} MB requested over 3 frames`);
}
