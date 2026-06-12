/** Trace sceUtilitySavedata* status flow for a game (focused debug). */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame(process.argv[2] ?? "test/fixtures/space-invaders.iso");

const seq: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name.includes("Savedata")) {
    const a0 = regs.getGpr(4) >>> 0;
    orig(code, regs);
    if (seq.length < 80) seq.push(`${name}(0x${a0.toString(16)}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
    return;
  }
  orig(code, regs);
};

for (let f = 0; f < 300; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) break;
}

// Collapse consecutive duplicates
let last = "";
let count = 0;
for (const s of [...seq, "<end>"]) {
  if (s === last) { count++; continue; }
  if (last) console.log(`  ${last}${count > 1 ? `  ×${count}` : ""}`);
  last = s; count = 1;
}
