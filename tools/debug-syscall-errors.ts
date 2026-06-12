/** Log syscalls that return error codes (v0 >= 0x80000000) during game boot.
 *  Usage: npx tsx tools/debug-syscall-errors.ts <iso> [frames] */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame(process.argv[2] ?? "test/fixtures/space-invaders.iso");
const maxFrames = parseInt(process.argv[3] ?? "600", 10);

const errs = new Map<string, { count: number; ret: string }>();
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (v0 >= 0x80000000 && nid != null) {
    const name = NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`;
    const key = `t${emu.hle.currentThreadId}:${name}`;
    const e = errs.get(key) ?? { count: 0, ret: "" };
    e.count++;
    e.ret = `0x${v0.toString(16)}`;
    errs.set(key, e);
  }
};

for (let f = 0; f < maxFrames; f++) {
  emu.runFrame();
  await Promise.resolve();
}

console.log("syscalls returning errors:");
for (const [key, e] of [...errs.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${key}: ×${e.count} last=${e.ret}`);
}
