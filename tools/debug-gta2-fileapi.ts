/** Trace GTA's internal file API: open(0x8938f04), size(0x8938fd8),
 *  read(0x8939050), close(0x8938f40) — args and return values. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gta.iso");
const icon1 = emu.hle.fileData.get("disc0:/psp_game/icon1.pmf")!;
emu.hle.fileData.set("disc0:/sce_lbn0x0_size0x6b800", icon1);

const FNS: Record<number, string> = {
  0x8938f04: "gtaOpen", 0x8938fd8: "gtaSize", 0x8939050: "gtaRead", 0x8938f40: "gtaClose",
};
function str(p: number): string {
  let s = ""; for (; s.length < 64; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
  return s;
}
const pending: Array<{ name: string; ra: number; desc: string }> = [];
let frame = 0, logged = 0;
const cpu = emu.cpu as unknown as { step(): boolean };
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  const pc = emu.cpu.regs.pc;
  const r = emu.cpu.regs;
  const fn = FNS[pc];
  if (fn && logged < 80) {
    const a0 = r.getGpr(4) >>> 0, a1 = r.getGpr(5) >>> 0, a2 = r.getGpr(6) >>> 0;
    let desc = `${fn}(0x${a0.toString(16)},0x${a1.toString(16)},0x${a2.toString(16)})`;
    if (fn === "gtaOpen") desc = `gtaOpen("${str(a0)}")`;
    pending.push({ name: fn, ra: r.getGpr(31) >>> 0, desc: `f${frame} t${emu.hle.currentThreadId} ${desc}` });
  }
  if (pending.length && pc === pending[pending.length - 1]!.ra) {
    const p = pending.pop()!;
    console.log(`${p.desc} → 0x${(r.getGpr(2) >>> 0).toString(16)}`);
    logged++;
  }
  return origStep();
};
for (frame = 0; frame < 12 && logged < 80; frame++) { emu.runFrame(); await Promise.resolve(); }
console.log(`final pc=0x${emu.cpu.regs.pc.toString(16)}, str@0x8b81b88="${str(0x8b81b88)}"`);
