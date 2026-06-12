import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("public/burnout-legends.iso");
const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a0 = regs.getGpr(4)>>>0, a1 = regs.getGpr(5)>>>0;
  let path = "";
  if (name === "sceIoOpenAsync" || name === "sceIoOpen") { for (let i=0;i<48;i++){const c=emu.bus.readU8(a0+i);if(!c)break;path+=String.fromCharCode(c);} }
  orig(code, regs);
  if (name.includes("Async") || name === "sceIoOpen") {
    logs.push(`f${frame} t${emu.hle.currentThreadId} ${name}(${path||"fd="+a0}${name.includes("Read")?",buf=0x"+a1.toString(16):""}) -> 0x${(regs.getGpr(2)>>>0).toString(16)}`);
  }
};
for (let f = 0; f < 60; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
for (const s of logs.slice(0, 50)) console.log("  "+s);
