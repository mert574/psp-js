/** Trace sceGeDrawSync / sceGeListSync calls and GE list states for a game. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame(process.argv[2] ?? "public/burnout-legends.iso");
const frames = parseInt(process.argv[3] ?? "120", 10);

const samples: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const isDrawSync = nid === 0xb287bd61;
  const isListSync = nid === 0x03444eb4;
  const isEnqueue = nid === 0xab49e76a;
  const a0 = regs.getGpr(4) >>> 0;
  orig(code, regs);
  if ((isDrawSync || isListSync || isEnqueue) && samples.length < 60) {
    const name = isDrawSync ? "DrawSync" : isListSync ? "ListSync" : "Enqueue";
    const states = [...emu.hle.geLists.values()]
      .filter((e: any) => e.state !== 0)
      .map((e: any) => `${e.id}:s${e.state}@${(e.pc >>> 0).toString(16)}/stall=${(e.stallAddr >>> 0).toString(16)}`)
      .join(",");
    samples.push(`${name}(${isDrawSync || isListSync ? a0 : "0x" + a0.toString(16)}) → 0x${(regs.getGpr(2) >>> 0).toString(16)} lists[${states}]`);
  }
};

for (let f = 0; f < frames; f++) {
  emu.runFrame();
  await Promise.resolve();
}

// Collapse duplicates
let last = "";
let count = 0;
for (const s of [...samples, "<end>"]) {
  if (s === last) { count++; continue; }
  if (last) console.log(`${last}${count > 1 ? `  ×${count}` : ""}`);
  last = s; count = 1;
}
