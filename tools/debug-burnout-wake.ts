import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("public/burnout-legends.iso");
const counts = new Map<string, number>();
const t23: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const tid = emu.hle.currentThreadId;
  if (name.includes("Wakeup") || name.includes("Alarm") || name.includes("VTimer") || name.includes("SetEventFlag") || name.includes("Callback")) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ((tid === 2 || tid === 3) && frame < 40) t23.push(`f${frame} t${tid} ${name}`);
  orig(code, regs);
};
for (let f = 0; f < 300; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
console.log("=== wake/alarm/cb/eventflag calls ===");
for (const [k,v] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);
console.log("=== t2/t3 activity (first 40 frames) ===");
let last="",c=0,lf="";
for (const s of [...t23,"<end>"]) { const k=s.replace(/^f\d+ /,""); if(k===last){c++;continue;} if(lf)console.log(`  ${lf}${c>1?` x${c}`:""}`); last=k;c=1;lf=s; }
