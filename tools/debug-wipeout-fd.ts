/** Find what file wipeout's video fill callback reads (fd 14) and its mounted size. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/wipeout-pure.iso");

const orig = emu.hle.dispatch.bind(emu.hle);
let logs = 0;
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  let path = "";
  if (name.startsWith("sceIoOpen")) {
    let p = regs.getGpr(4) >>> 0, s = "";
    for (let i = 0; i < 96; i++) { const c = emu.bus.readU8(p + i); if (!c) break; s += String.fromCharCode(c); }
    path = s;
  }
  orig(code, regs);
  if (name.startsWith("sceIoOpen")) {
    const fd = regs.getGpr(2) | 0;
    if (fd >= 12 && fd <= 16 && logs < 20) {
      console.log(`${name}("${path}") → fd=${fd}`);
      logs++;
    }
  }
};

for (let f = 0; f < 290; f++) { emu.runFrame(); await Promise.resolve(); }

console.log("\nmounted files (>10MB):");
for (const [p, d] of emu.hle.fileData) {
  if (d.byteLength > 10_000_000) console.log(`  ${p}: ${d.byteLength} (0x${d.byteLength.toString(16)})`);
}
