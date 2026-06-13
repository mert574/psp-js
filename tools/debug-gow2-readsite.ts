/**
 * Decide: is the gow vtable clobber a TIMING bug (game didn't wait for the async
 * read before reusing the buffer) or a LAYOUT bug (addresses shouldn't overlap)?
 * Logs, in order: the KRATOS ReadAsync into the colliding buffer, every async-IO
 * call on that fd (Wait/Poll) with returns, the write to the vtable slot
 * 0x99fcb60, and when the deferred read actually completes (writes the buffer).
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { IO } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const k = emu.hle;
const bus = emu.bus;
const SLOT = 0x99fcb60;

const seq: string[] = [];
const push = (s: string) => { if (seq.length < 120) seq.push(s); };

// watch writes to the vtable slot
const ow32 = bus.writeU32.bind(bus);
bus.writeU32 = (addr, v) => {
  if ((addr >>> 0) === SLOT) push(`  WRITE slot 0x99fcb60 = 0x${(v >>> 0).toString(16)} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  ow32(addr, v);
};
// detect the deferred read landing in the slot region (buffer write covering SLOT)
const owB = bus.writeBytes?.bind(bus);
const orig = k.dispatch.bind(k);
let kratosFd = -1;
(k as unknown as { dispatch: (c: number, r: typeof emu.cpu.regs, b: typeof bus) => void }).dispatch = (code, regs, b) => {
  const nid = k.getNidBySyscallForTest(code);
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0;
  if (nid === IO.sceIoReadAsync && a1 <= SLOT && a1 + a2 > SLOT) {
    kratosFd = a0;
    push(`READA fd=0x${a0.toString(16)} buf=0x${a1.toString(16)} size=0x${a2.toString(16)} (covers slot) pc=0x${emu.cpu.regs.pc.toString(16)}`);
  }
  orig(code, regs, b);
  const ret = regs.getGpr(2) >>> 0;
  if (a0 === kratosFd && kratosFd >= 0) {
    if (nid === IO.sceIoWaitAsync) push(`  WaitAsync fd=0x${a0.toString(16)} -> 0x${ret.toString(16)}`);
    else if (nid === IO.sceIoWaitAsyncCB) push(`  WaitAsyncCB fd=0x${a0.toString(16)} -> 0x${ret.toString(16)}`);
    else if (nid === IO.sceIoPollAsync) push(`  PollAsync fd=0x${a0.toString(16)} -> 0x${ret.toString(16)}`);
  }
};
void owB;

for (let f = 0; f < 20; f++) { emu.runFrame(); if (emu.halted || emu.cpu.stepFaulted) break; }

console.log(`RESULT halted=${emu.halted} faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
console.log("RESULT ordered sequence (read / waits / slot writes):");
for (const l of seq) console.log(l);
