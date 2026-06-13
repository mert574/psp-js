import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("test/fixtures/burnout-legends.iso");
const kernel = emu.hle;
const unimpl = new Map<string, number>();
const orig = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: (c: number, r: { getGpr(n: number): number }) => void }).dispatch = (code, regs) => {
  const before = regs.getGpr(2) >>> 0;
  orig(code, regs as never);
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? null) : null;
  const ret = regs.getGpr(2) >>> 0;
  // Heuristic: unimplemented handlers return 0 or leave v0; we flag by NID with no name OR known-unimpl marker. Just collect all called NIDs with names matching mpeg/video/codec/sas/audio.
  if (name && /mpeg|video|codec|avc|psmf|sas|atrac|audio/i.test(name)) unimpl.set(name, (unimpl.get(name) ?? 0) + 1);
  else if (!name && nid != null) unimpl.set(`0x${nid.toString(16)}(unnamed)`, (unimpl.get(`0x${nid.toString(16)}(unnamed)`) ?? 0) + 1);
};
for (let f=0;f<400;f++) emu.runFrame();
console.log("RESULT media-related + unnamed syscalls burnout calls:");
for (const [k,c] of [...unimpl.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${c}x ${k}`);
