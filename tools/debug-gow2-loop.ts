/**
 * Characterize gow's busy-loop over the clean pre-fault window (frames 0-14):
 * which thread spins, the syscall sequence it repeats, and the interrupt state
 * when sceKernelIsCpuIntrEnable is polled.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;

let trace = false;
const seq: string[] = [];           // recent syscall sequence (current thread)
const perThreadSyscalls = new Map<number, Map<string, number>>();
let intrEnabledTrueAtPoll = 0, intrEnabledFalseAtPoll = 0;

const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `code${code}`;
  if (trace) {
    const tid = kernel.currentThreadId;
    let m = perThreadSyscalls.get(tid);
    if (!m) { m = new Map(); perThreadSyscalls.set(tid, m); }
    m.set(name, (m.get(name) ?? 0) + 1);
    if (name === "sceKernelIsCpuIntrEnable") {
      if ((kernel as unknown as { interruptsEnabled: boolean }).interruptsEnabled) intrEnabledTrueAtPoll++;
      else intrEnabledFalseAtPoll++;
    }
    if (seq.length < 80) seq.push(`t${tid} ${name}`);
  }
  return origDispatch(code, regs);
};

// per-thread step attribution
const perThreadSteps = new Map<number, number>();
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  if (trace) perThreadSteps.set(kernel.currentThreadId, (perThreadSteps.get(kernel.currentThreadId) ?? 0) + 1);
  return origStep();
};

for (let f = 0; f < 12; f++) emu.runFrame();
trace = true;
for (let f = 0; f < 2 && !emu.halted; f++) emu.runFrame();

console.log(`halted=${emu.halted} pc=0x${cpu.regs.pc.toString(16)}`);
console.log("\nsteps per thread (2 traced frames):");
for (const [tid, n] of [...perThreadSteps.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  t${tid}: ${n}`);
console.log(`\nIsCpuIntrEnable poll: interruptsEnabled=true ${intrEnabledTrueAtPoll}×, false ${intrEnabledFalseAtPoll}×`);
console.log("\nper-thread top syscalls:");
for (const [tid, m] of perThreadSyscalls) {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`).join("  ");
  console.log(`  t${tid}: ${top}`);
}
console.log("\nfirst 80 syscalls in sequence:");
console.log("  " + seq.join("\n  "));
