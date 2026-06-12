// Trace syscalls made by LBP's pthread worker threads (tid >= 5) to find
// which call fails with 0x80020198 before the "non-pthread thread" assert.
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/lbp.iso");
const k = emu.hle as any;

const origDispatch = k.dispatch.bind(k);
let lines = 0;
k.dispatch = (code: number, regs: any) => {
  const tid = k.currentThreadId;
  const trace = tid >= 5 && lines < 400;
  let nid: number | undefined, name: string | undefined, a0 = 0, a1 = 0, a2 = 0;
  if (trace) {
    nid = k.syscallToNid.get(code);
    name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `code:0x${code.toString(16)}`;
    a0 = regs.getGpr(4) >>> 0; a1 = regs.getGpr(5) >>> 0; a2 = regs.getGpr(6) >>> 0;
  }
  origDispatch(code, regs);
  if (trace) {
    const v0 = regs.getGpr(2) >>> 0;
    lines++;
    console.log(`[T] t${tid} ${name}(0x${a0.toString(16)}, 0x${a1.toString(16)}, 0x${a2.toString(16)}) -> 0x${v0.toString(16)}`);
  }
  // also log any error returns from any thread (negative v0), limited
  else if (tid > 0) {
    const v0 = regs.getGpr(2) >>> 0;
    if (v0 >= 0x80000000 && lines < 400) {
      const nid2 = k.syscallToNid.get(code);
      const nm = nid2 != null ? (NID_NAMES.get(nid2) ?? `0x${nid2.toString(16)}`) : `code:0x${code.toString(16)}`;
      lines++;
      console.log(`[E] t${tid} ${nm} -> 0x${v0.toString(16)}`);
    }
  }
};

for (let f = 0; f < 240; f++) { emu.runFrame(); await Promise.resolve(); }
console.log("done, traced lines:", lines);
