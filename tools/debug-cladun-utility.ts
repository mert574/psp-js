/** Trace cladun's sceUtility savedata lifecycle + event flags/semas to find the loading gate. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/cladun-rpg.iso");

const log: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const tid = emu.hle.currentThreadId;
  const a0 = regs.getGpr(4) >>> 0;
  const a1 = regs.getGpr(5) >>> 0;
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (name.startsWith("sceUtilitySavedata") || name.startsWith("sceKernelCreateEventFlag") ||
      name.startsWith("sceKernelSetEventFlag") || name.startsWith("sceKernelWaitEventFlag") ||
      name.startsWith("sceKernelPollEventFlag") || name.startsWith("sceKernelDeleteEventFlag") ||
      name.startsWith("sceKernelSignalSema") || name.startsWith("sceKernelWaitSema")) {
    log.push(`f${frame} t${tid} ${name}(0x${a0.toString(16)}, 0x${a1.toString(16)}) → 0x${v0.toString(16)}`);
  }
};

for (let f = 0; f < 900; f++) {
  frame = f;
  emu.runFrame();
  await Promise.resolve();
}

// dedupe consecutive same-key lines
let last = "", count = 0, lastFull = "";
for (const s of [...log, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`  ${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}
console.log(`total: ${log.length}`);
