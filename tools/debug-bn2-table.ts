import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const rdStr = (addr: number, max = 96) => {
  let s = "";
  for (let i = 0; i < max; i++) { const c = emu.bus.readU8(addr + i); if (!c) break; s += (c >= 32 && c < 127) ? String.fromCharCode(c) : `\\x${c.toString(16)}`; }
  return s;
};
// Hook entry to lookup fn 0x8a43a2c to capture the searched path
const cpu: any = emu.cpu;
const regs: any = emu.cpu.regs;
const origStep = cpu.step.bind(cpu);
const lookups: string[] = [];
cpu.step = () => {
  const pc = regs.pc >>> 0;
  if (pc === 0x8a43a2c && lookups.length < 10) {
    const a1 = regs.getGpr(5) >>> 0;
    const count = emu.bus.readU32(0x8bb2efc) >>> 0;
    const base = emu.bus.readU32(0x8bb2ef8) >>> 0;
    lookups.push(`lookup("${rdStr(a1)}") table base=0x${base.toString(16)} count=${count}`);
    if (lookups.length === 1 && count > 0 && base) {
      for (let i = 0; i < Math.min(count, 12); i++) {
        const np = emu.bus.readU32(base + i * 12) >>> 0;
        const sz = emu.bus.readU32(base + i * 12 + 4) >>> 0;
        const x = emu.bus.readU32(base + i * 12 + 8) >>> 0;
        lookups.push(`   [${i}] name="${rdStr(np)}" size=${sz} x=0x${x.toString(16)}`);
      }
    }
  }
  return origStep();
};
let stopped = false;
const orig2 = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, r) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceIoReadAsync") stopped = true;
  orig2(code, r);
};
for (let f = 0; f < 4 && !stopped; f++) { emu.runFrame(); await Promise.resolve(); }
for (const s of lookups) console.log(s);
