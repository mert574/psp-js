/** Trace wipeout's display SetFrameBuf args vs GE FRAMEBUFPIXFMT commands. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/wipeout-pure.iso");
let frame = 0;
let logs = 0;

const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? NID_NAMES.get(nid) ?? "" : "";
  if (name === "sceDisplaySetFrameBuf" && logs < 40) {
    console.log(`f${frame} SetFrameBuf(addr=0x${(regs.getGpr(4)>>>0).toString(16)}, w=${regs.getGpr(5)}, fmt=${regs.getGpr(6)}, sync=${regs.getGpr(7)})`);
    logs++;
  }
  orig(code, regs);
};

// hook GE processor command stream BEFORE any frame runs
let fmtLogs = 0;
const proc = (emu.hle as any).ensureGeProcessor();
const origEC = proc.executeCommand.bind(proc);
proc.executeCommand = (cmd: number, param: number) => {
  if (cmd === 0xd2 && fmtLogs < 12) {
    console.log(`f${frame} GE FRAMEBUFPIXFMT=${param & 3} (fbPtr=0x${(proc.fbPtr >>> 0).toString(16)})`);
    fmtLogs++;
  }
  return origEC(cmd, param);
};

for (let f = 0; f < 90; f++) {
  frame = f;
  emu.runFrame();
  await Promise.resolve();
}
console.log(`final proc.fbFormat=${proc.fbFormat}`);
