import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("public/burnout-legends.iso");
const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a0 = regs.getGpr(4) >>> 0;
  let path = "";
  if (name.startsWith("sceIoOpen") || name.includes("Module") || name === "sceIoDopen") {
    for (let i = 0; i < 64; i++) { const c = emu.bus.readU8(a0 + i); if (!c) break; path += String.fromCharCode(c); }
  }
  orig(code, regs);
  if (frame >= 100 && frame <= 103 && (true)) {
    logs.push(`f${frame} ${name}(${path || "0x"+a0.toString(16)}) -> 0x${(regs.getGpr(2)>>>0).toString(16)}`);
  }
};
for (let f = 0; f < 110; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
let last="",c=0,lf="";
for (const s of [...logs,"<end>"]) { const k=s.replace(/^f\d+ /,""); if(k===last){c++;continue;} if(lf)console.log(`  ${lf}${c>1?` x${c}`:""}`); last=k;c=1;lf=s; }
