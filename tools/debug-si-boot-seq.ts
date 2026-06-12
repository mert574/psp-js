/** Log every distinct syscall t1 makes between frames 40-200 (dedup consecutive). */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/space-invaders.iso");

const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  const tid = emu.hle.currentThreadId;
  const a0 = regs.getGpr(4) >>> 0;
  orig(code, regs);
  if (frame >= 40 && frame <= 200 && tid === 1) {
    logs.push(`f${frame} ${name}(0x${a0.toString(16)}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
  }
};

for (let f = 0; f < 210; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }

let last = "", count = 0, lastFull = "";
for (const s of [...logs, "<end>"]) {
  const key = s.replace(/^f\d+ /, "").replace(/\(0x[0-9a-f]+\)/, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`  ${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}
