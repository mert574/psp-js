import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
const counts = new Map<string, number>();
const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (c: number, r: { getGpr(n: number): number }) => void }).dispatch = (code, regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  orig(code, regs as never);
  if (/Mpeg|Csc|YCbCr/i.test(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
};
for (let f = 0; f < 600; f++) emu.runFrame();
console.log("RESULT mpeg-related call counts:");
for (const [k, c] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${c}x ${k}`);
