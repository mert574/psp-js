/** Trace OFFSET_X/Y and viewport writes in puyo-puyo's GE lists. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/puyo-puyo.iso");
const hk = emu.hle as any;
const ge = hk.ensureGeProcessor() as any;
const orig = ge.executeCommand.bind(ge);
const seen = new Map<number, Map<number, number>>();
let frame = 0;
ge.executeCommand = (op: number, param: number) => {
  if (op === 0x4c || op === 0x4d || op === 0x45 || op === 0x46) {
    let m = seen.get(op);
    if (!m) { m = new Map(); seen.set(op, m); }
    m.set(param, (m.get(param) ?? 0) + 1);
  }
  orig(op, param);
};

for (let f = 0; f < 300; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }

const names: Record<number, string> = { 0x4c: "OFFSET_X", 0x4d: "OFFSET_Y", 0x45: "VPCENTER_X", 0x46: "VPCENTER_Y" };
for (const [op, m] of seen) {
  console.log(`${names[op]}:`);
  for (const [param, count] of m) console.log(`  param=0x${param.toString(16)} (${param}) x${count}`);
}
