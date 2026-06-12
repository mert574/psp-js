/** Trace all sceMpeg/scePsmf calls a game makes, with args, in order.
 *  Usage: npx tsx tools/debug-mpeg-calls.ts <iso> [frames] */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame(process.argv[2] ?? "public/wipeout-pure.iso");
const maxFrames = parseInt(process.argv[3] ?? "400", 10);

const log: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const isMpeg = name.startsWith("sceMpeg") || name.startsWith("scePsmf") || name.startsWith("sceVideocodec") || name.startsWith("sceMpegbase");
  const args = isMpeg ? [4, 5, 6, 7].map((r) => "0x" + (regs.getGpr(r) >>> 0).toString(16)).join(",") : "";
  orig(code, regs);
  if (isMpeg) {
    log.push(`f${frame} t${emu.hle.currentThreadId} ${name}(${args}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
  }
};

for (let f = 0; f < maxFrames; f++) {
  frame = f;
  emu.runFrame();
  await Promise.resolve();
}

let last = "", count = 0, lastFull = "";
for (const s of [...log, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`  ${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}
console.log(`total mpeg calls: ${log.length}`);
