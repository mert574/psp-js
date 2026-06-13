/** Trace calls to the reloc fn 0x8a313a0 (args, ra) and watch fd6 reads. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gta.iso");
const icon1 = emu.hle.fileData.get("disc0:/psp_game/icon1.pmf")!;
emu.hle.fileData.set("disc0:/sce_lbn0x0_size0x6b800", icon1);

const FN = 0x8a3137c;
let calls = 0;
const cpu = emu.cpu as unknown as { step(): boolean };
const origStep = cpu.step.bind(cpu);
let frame = 0;
cpu.step = () => {
  const pc = emu.cpu.regs.pc;
  if (pc === FN && calls < 25) {
    calls++;
    const r = emu.cpu.regs;
    const a0 = r.getGpr(4) >>> 0, a1 = r.getGpr(5) >>> 0, ra = r.getGpr(31) >>> 0;
    const words = [...Array(8)].map((_, i) => (emu.bus.readU32(a0 + i * 4) >>> 0).toString(16)).join(" ");
    console.log(`call#${calls} f${frame} t${emu.hle.currentThreadId} fn(a0=0x${a0.toString(16)}, a1=0x${a1.toString(16)}) ra=0x${ra.toString(16)} buf[0..8]=${words}`);
  }
  return origStep();
};
for (frame = 0; frame < 40; frame++) { emu.runFrame(); await Promise.resolve(); if (calls >= 25) break; }
console.log(`total traced=${calls}, final pc=0x${emu.cpu.regs.pc.toString(16)}`);
