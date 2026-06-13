import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
let frame = 0;
let raSeen: number | null = null;
let spSeen = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceIoReadAsync" && raSeen === null) {
    raSeen = regs.getGpr(31) >>> 0;
    spSeen = regs.getGpr(29) >>> 0;
    console.log(`ReadAsync at frame ${frame}: ra=0x${raSeen.toString(16)} sp=0x${spSeen.toString(16)} a2=${regs.getGpr(6)>>>0}`);
    // dump some stack words to find caller chain
    for (let i = 0; i < 24; i++) {
      const w = emu.bus.readU32(spSeen + i * 4) >>> 0;
      if (w >= 0x08800000 && w < 0x0c000000) console.log(`  stack[+0x${(i*4).toString(16)}] = 0x${w.toString(16)}`);
    }
  }
  orig(code, regs);
};
for (let f = 0; f < 5 && raSeen === null; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
