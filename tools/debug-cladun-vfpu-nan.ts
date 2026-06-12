/** Find the first VFPU op that writes NaN in cladun — dump pc, raw instr, and inputs. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/cladun-rpg.iso");
const regs = emu.cpu.regs as any;

let hits = 0;
const origSet = regs.setVfpr.bind(regs);
regs.setVfpr = (index: number, value: number) => {
  if (!Number.isFinite(value) && hits < 10) {
    hits++;
    const pc = (emu.cpu.regs as any).pc >>> 0;
    const raw = emu.bus.readU32(pc) >>> 0;
    console.log(`NaN → vfpr[${index}] at pc=0x${pc.toString(16)} raw=0x${raw.toString(16).padStart(8, "0")} thread=t${emu.hle.currentThreadId}`);
    // dump some vfpr state
    const row = [...regs.vfpr.slice(Math.max(0, index - 4), index + 4)].map((v: number) => v.toPrecision(4)).join(", ");
    console.log(`  nearby vfpr: [${row}]`);
  }
  return origSet(index, value);
};
const origSetBits = regs.setVfprBits.bind(regs);
regs.setVfprBits = (index: number, value: number) => {
  if ((value & 0x7f800000) === 0x7f800000 && (value & 0x7fffff) !== 0 && hits < 10) {
    hits++;
    const pc = (emu.cpu.regs as any).pc >>> 0;
    const raw = emu.bus.readU32(pc) >>> 0;
    console.log(`NaN(bits) → vfpr[${index}] at pc=0x${pc.toString(16)} raw=0x${raw.toString(16).padStart(8, "0")} thread=t${emu.hle.currentThreadId}`);
  }
  return origSetBits(index, value);
};

for (let f = 0; f < 120 && hits < 10; f++) { emu.runFrame(); await Promise.resolve(); }
console.log(`done, hits=${hits}`);
