/** Trace syscalls made INSIDE the ringbuffer Put callback (mini-CPU loop). */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES, PSMF } from "../src/kernel/nids.js";

const emu = await loadGame("public/wipeout-pure.iso");

let inPut = false;
let putLogs = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (nid === PSMF.sceMpegRingbufferPut) {
    inPut = true;
    if (putLogs < 3) console.log(`>>> Put(num=${regs.getGpr(5)}, avail=${regs.getGpr(6)})`);
    orig(code, regs);
    inPut = false;
    if (putLogs < 3) { console.log(`<<< Put → ${regs.getGpr(2)}`); putLogs++; }
    return;
  }
  const a0 = regs.getGpr(4) >>> 0;
  orig(code, regs);
  if (inPut && putLogs < 3) {
    console.log(`    [cb] ${name}(a0=0x${a0.toString(16)}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
  }
};

for (let f = 0; f < 290; f++) { emu.runFrame(); await Promise.resolve(); }
