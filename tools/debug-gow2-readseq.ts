/**
 * Log gow's sceIoOpen/Read/ReadAsync sequence (fd, buffer addr, size) to diff
 * against PPSSPP's log and find the first divergent buffer address — the point
 * where our internal allocation drifts 0x30000 from PPSSPP.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;

// recover past the frame-15 fault so we can observe the whole stream setup
const origStep = cpu.step.bind(cpu);
cpu.step = () => { if ((cpu.regs.pc >>> 0) === 0) cpu.regs.pc = cpu.regs.gpr[31]! >>> 0; return origStep(); };

const lines: string[] = [];
const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0;
  origDispatch(code, regs);
  if (lines.length >= 70) return;
  if (name === "sceIoOpen" || name === "sceIoOpenAsync") {
    const path = kernel.readCString(emu.bus, a0);
    lines.push(`${name}(${path}) → fd=${regs.getGpr(2) >>> 0}`);
  } else if (name === "sceIoRead" || name === "sceIoReadAsync") {
    lines.push(`${name}(fd=${a0}, buf=0x${a1.toString(16)}, size=${a2})`);
  } else if (name === "sceKernelMaxFreeMemSize" || name === "sceKernelTotalFreeMemSize") {
    lines.push(`${name}() → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
  } else if (name === "sceKernelCreateFpl") {
    lines.push(`sceKernelCreateFpl(blockSize=0x${a2.toString(16)}? a3=0x${(regs.getGpr(7) >>> 0).toString(16)})`);
  }
};

for (let f = 0; f < 30 && lines.length < 70; f++) emu.runFrame();
for (const l of lines) console.log(l);
