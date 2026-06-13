import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("test/fixtures/wipeout-pure.iso");
const kernel = emu.hle;
const bus = emu.bus;
// Find the ringbuffer data ptr from Construct, then dump first bytes after each Put.
let rbDataPtr = 0;
const ev: string[] = [];
const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (a:number,b:{getGpr(n:number):number})=>void }).dispatch = (code, regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceMpegRingbufferConstruct") rbDataPtr = regs.getGpr(6)>>>0;
  orig(code, regs as never);
  const ret = regs.getGpr(2)>>>0;
  if (name === "sceMpegRingbufferPut" && ret > 0 && ev.length < 6 && rbDataPtr) {
    const head = Array.from({length:16},(_,i)=>bus.readU8(rbDataPtr+i).toString(16).padStart(2,"0")).join(" ");
    ev.push(`after Put(added ${ret}): dataPtr head = ${head}`);
  }
};
for (let f=0;f<400;f++) emu.runFrame();
console.log("RESULT wipeout fed PS bytes (expect 00 00 01 ba pack header):");
console.log(ev.join("\n") || "(none)");
