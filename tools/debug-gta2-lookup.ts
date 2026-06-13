/** Trace gta fs catalog init (0x8b6b650) and name lookup (0x88b53c4). */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gta.iso");
const icon1 = emu.hle.fileData.get("disc0:/psp_game/icon1.pmf")!;
emu.hle.fileData.set("disc0:/sce_lbn0x0_size0x6b800", icon1);

function str(p: number): string {
  let s = ""; for (; s.length < 70; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
  return s;
}
let frame = 0, initDepth = 0;
const pend: Array<{ ra: number; desc: string }> = [];
const cpu = emu.cpu as unknown as { step(): boolean };
const origStep = cpu.step.bind(cpu);
// trace syscalls made while inside catalog init
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  orig(code, regs);
  if (initDepth > 0) console.log(`    [init syscall] ${name} → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
};
cpu.step = () => {
  const r = emu.cpu.regs;
  const pc = r.pc;
  if (pc === 0x8b6b650) { initDepth++; console.log(`f${frame} t${emu.hle.currentThreadId} catalogInit ENTER ra=0x${(r.getGpr(31)>>>0).toString(16)}`); pend.push({ ra: r.getGpr(31) >>> 0, desc: "catalogInit" }); }
  else if (pc === 0x88b53c4 && pend.length < 30) {
    pend.push({ ra: r.getGpr(31) >>> 0, desc: `lookup("${str(r.getGpr(4) >>> 0)}")` });
  }
  if (pend.length && pc === pend[pend.length - 1]!.ra) {
    const p = pend.pop()!;
    if (p.desc === "catalogInit") initDepth--;
    console.log(`f${frame} ${p.desc} → 0x${(r.getGpr(2) >>> 0).toString(16)}`);
  }
  return origStep();
};
for (frame = 0; frame < 10; frame++) { emu.runFrame(); await Promise.resolve(); }
