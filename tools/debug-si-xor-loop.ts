/** Capture SI's per-frame XOR loop inputs: buffer addr, key addr, sizes. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/space-invaders.iso");
const regs = emu.cpu.regs as any;
const cpu = emu.cpu as any;

let hits = 0;
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  const pc = regs.pc >>> 0;
  if (pc === 0x889cd30 && hits < 8) {
    hits++;
    const s6 = regs.getGpr(22) >>> 0;
    const count = emu.bus.readU32(s6 + 44);
    const a1 = regs.getGpr(5) >>> 0;
    const fp = regs.getGpr(30) >>> 0;
    const key = emu.bus.readU32(fp + 30856) >>> 0;
    let preview = "";
    for (let i = 0; i < 16; i++) preview += emu.bus.readU8(a1 + i).toString(16).padStart(2, "0") + " ";
    console.log(`XOR loop: s6=0x${s6.toString(16)} count=${count} buf(a1)=0x${a1.toString(16)} key=0x${key.toString(16)} buf[0..16]=${preview}`);
  }
  return origStep();
};

for (let f = 0; f < 120 && hits < 8; f++) { emu.runFrame(); await Promise.resolve(); }
console.log(`hits=${hits}`);
