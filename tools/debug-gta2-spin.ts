/** Inspect the GTA spin loop at 0x8a31414: dump regs + the header at $a1. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gta.iso");
for (let f = 0; f < 30; f++) { emu.runFrame(); await Promise.resolve(); }

const r = emu.cpu.regs;
console.log(`pc=0x${r.pc.toString(16)} tid=${emu.hle.currentThreadId}`);
const names = ["zero","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
for (let i = 0; i < 32; i++) {
  if ([4,5,6,7,8,9,16,17,18,19,29,31].includes(i))
    console.log(`  ${names[i]} = 0x${(r.getGpr(i) >>> 0).toString(16)}`);
}
const a1 = r.getGpr(5) >>> 0;
console.log(`header at a1=0x${a1.toString(16)}:`);
for (let o = 0; o <= 0x20; o += 4) {
  console.log(`  +0x${o.toString(16)}: 0x${(emu.bus.readU32(a1 + o) >>> 0).toString(16)}`);
}
const a3 = r.getGpr(7) >>> 0;
console.log(`mem at a3=0x${a3.toString(16)}: ${[...Array(16)].map((_, i) => (emu.bus.readU32(a3 + i * 4) >>> 0).toString(16)).join(" ")}`);
// stack walk: scan stack for RAM text addresses
const sp = r.getGpr(29) >>> 0;
const cand: string[] = [];
for (let o = 0; o < 0x200 && cand.length < 12; o += 4) {
  const v = emu.bus.readU32(sp + o) >>> 0;
  if (v >= 0x08804000 && v < 0x0bc00000 && (v & 3) === 0) cand.push(`sp+0x${o.toString(16)}=0x${v.toString(16)}`);
}
console.log("stack candidates:", cand.join(" "));
