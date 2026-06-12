/** Trace SI's memory stick / devctl / callback notification activity. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/space-invaders.iso");

const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const watch = name.includes("Devctl") || name.includes("Callback") || name.includes("MScm") ||
    name.includes("MemoryStick") || name.startsWith("sceIoChdir") || name.includes("Notify");
  let arg = "";
  if (watch && name === "sceIoDevctl") {
    let p = regs.getGpr(4) >>> 0, s = "";
    for (let i = 0; i < 32; i++) { const c = emu.bus.readU8(p + i); if (!c) break; s += String.fromCharCode(c); }
    arg = `"${s}" cmd=0x${(regs.getGpr(5) >>> 0).toString(16)}`;
  } else if (watch) {
    arg = `a0=0x${(regs.getGpr(4) >>> 0).toString(16)} a1=0x${(regs.getGpr(5) >>> 0).toString(16)}`;
  }
  orig(code, regs);
  if (watch) logs.push(`f${frame} t${emu.hle.currentThreadId} ${name}(${arg}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
};

for (let f = 0; f < 400; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }

let last = "", count = 0, lastFull = "";
for (const s of [...logs, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`  ${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}
