/** Sample burnout's spin loop: memset entries + callers. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/burnout-legends.iso");
const cpu = emu.cpu as any;

// run past boot
for (let f = 0; f < 15; f++) {
  emu.runFrame();
  await Promise.resolve();
}

// Trap the moment any thread's SAVED context points into the GE callback
// trampoline / kernel RAM — that's the corruption, whoever does it.
const hle: any = emu.hle;
const HleProto = Object.getPrototypeOf(hle);
let trapped = false;

function checkCtx(where: string, t: any) {
  if (trapped) return;
  const pc = t.context.pc >>> 0;
  const ra = t.context.gpr[31] >>> 0;
  if ((ra >= 0x8000000 && ra < 0x8000020) || (pc >= 0x8000000 && pc < 0x8804000 && pc !== 0)) {
    trapped = true;
    console.log(`CORRUPT ${where}: t${t.id} ctx.pc=0x${pc.toString(16)} ctx.ra=0x${ra.toString(16)} inCb=${hle.suppressReschedule}`);
    console.log(new Error("stack").stack?.split("\n").slice(2, 9).join("\n"));
  }
}

const origSave = HleProto.saveContext;
HleProto.saveContext = function (t: any, regs: any) {
  origSave.call(this, t, regs);
  checkCtx("saveContext", t);
};
const origRestore = HleProto.restoreContext;
HleProto.restoreContext = function (t: any, regs: any) {
  checkCtx("restoreContext", t);
  origRestore.call(this, t, regs);
};

for (let f = 0; f < 30 && !trapped; f++) { emu.runFrame(); await Promise.resolve(); }
console.log("trapped=" + trapped);
