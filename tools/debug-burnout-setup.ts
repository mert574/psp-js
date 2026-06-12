import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("public/burnout-legends.iso");
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a = [4,5,6,7].map(r => "0x"+(regs.getGpr(r)>>>0).toString(16));
  orig(code, regs);
  if (frame < 5 && (name.includes("SubIntr") || name === "sceGeSetCallback" || name === "sceKernelCreateThread" || name === "sceKernelStartThread" || name.includes("Sleep"))) {
    console.log(`f${frame} t${emu.hle.currentThreadId} ${name}(${a.join(",")}) -> 0x${(regs.getGpr(2)>>>0).toString(16)}`);
  }
};
for (let f = 0; f < 30; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
