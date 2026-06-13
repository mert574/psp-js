/**
 * Find WHERE gow's main thread reads the clock from. Histogram of the $ra
 * (caller) of every sceKernelGetSystemTimeWide, and the PC histogram of t1's
 * hot loop. One dominant caller = a single wait/pace loop; many = pervasive.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;

let trace = false;
const callerHist = new Map<number, number>();
const pcHist = new Map<number, number>();

const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  if (trace && name === "sceKernelGetSystemTimeWide") {
    const ra = regs.getGpr(31) >>> 0;
    callerHist.set(ra, (callerHist.get(ra) ?? 0) + 1);
  }
  return origDispatch(code, regs);
};

let n = 0;
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  if (trace && kernel.currentThreadId === 1 && (n++ & 0xf) === 0) {
    const r = (cpu.regs.pc >>> 0) & ~0xf;
    pcHist.set(r, (pcHist.get(r) ?? 0) + 1);
  }
  return origStep();
};

for (let f = 0; f < 12; f++) emu.runFrame();
trace = true;
emu.runFrame();

console.log("GetSystemTimeWide callers ($ra → count):");
for (const [ra, c] of [...callerHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log(`  0x${ra.toString(16)}: ${c}`);
console.log("\nt1 hot PC (×16 steps), top 16:");
for (const [r, c] of [...pcHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16))
  console.log(`  0x${r.toString(16)}: ${c}`);
