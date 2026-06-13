/**
 * Does gow call sceIoGetstat to resolve file LBNs, and do we return the right
 * sector? Then does it open sce_lbn paths (matching PPSSPP) or fall back to named
 * opens? Logs getstat(path)→sector and every sce_lbn open attempt + result.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;
const bus = emu.bus;

const origStep = cpu.step.bind(cpu);
cpu.step = () => { if ((cpu.regs.pc >>> 0) === 0) cpu.regs.pc = cpu.regs.gpr[31]! >>> 0; return origStep(); };

const lines: string[] = [];
const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0;
  if (lines.length < 60 && name === "sceIoGetstat") {
    const path = kernel.readCString(bus, a0);
    origDispatch(code, regs);
    const sector = a1 !== 0 ? (bus.readU32(a1 + 64) >>> 0) : 0;
    lines.push(`getstat(${path}) → ret=0x${(regs.getGpr(2) >>> 0).toString(16)} st_private[0]=0x${sector.toString(16)}`);
    return;
  }
  if (lines.length < 60 && (name === "sceIoOpen" || name === "sceIoOpenAsync")) {
    const path = kernel.readCString(bus, a0);
    if (path.includes("sce_lbn")) {
      origDispatch(code, regs);
      lines.push(`OPEN ${path} flags=0x${a1.toString(16)} → fd/ret=0x${(regs.getGpr(2) >>> 0).toString(16)}`);
      return;
    }
  }
  return origDispatch(code, regs);
};

for (let f = 0; f < 30 && lines.length < 60; f++) emu.runFrame();
console.log(`getstat calls + sce_lbn opens (${lines.length}):`);
for (const l of lines) console.log("  " + l);
