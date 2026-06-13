/**
 * Trace every userMemory allocation in gow boot to find which one places the
 * region that collides: the vtable table (~0x99fcb60) lands inside the streaming
 * read buffers (~0x99bc880..0x99fc880+0x40000). On real PSP they don't overlap,
 * so one of our allocations sits at the wrong address vs PPSSPP. Flags the
 * allocation(s) covering 0x99fcb60.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { BlockAllocator } from "../src/memory/block-allocator.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const k = emu.hle;
const TGT = 0x99fcb60;

const lines: string[] = [];
const um = k.userMemory;
const origAA = BlockAllocator.prototype.allocAligned;
const origAt = BlockAllocator.prototype.allocAt;
um.allocAligned = function (size: number, sg: number, g: number, top: boolean, tag: string): number {
  const addr = origAA.call(this, size, sg, g, top, tag) as number;
  const covers = addr >= 0 && addr <= TGT && addr + size > TGT;
  lines.push(`${covers ? "*** COVERS 0x99fcb60  " : ""}alloc 0x${(addr >>> 0).toString(16)}..0x${((addr + size) >>> 0).toString(16)} size=0x${size.toString(16)} top=${top} tag=${tag}`);
  return addr;
};
um.allocAt = function (pos: number, size: number, tag: string): number {
  const addr = origAt.call(this, pos, size, tag) as number;
  const covers = addr >= 0 && pos <= TGT && pos + size > TGT;
  lines.push(`${covers ? "*** COVERS 0x99fcb60  " : ""}allocAt 0x${(pos >>> 0).toString(16)}..0x${((pos + size) >>> 0).toString(16)} size=0x${size.toString(16)} tag=${tag}`);
  return addr;
};

for (let f = 0; f < 20; f++) { emu.runFrame(); if (emu.halted) break; }

console.log(`RESULT halted=${emu.halted} pc=0x${emu.cpu.regs.pc.toString(16)} totalAllocs=${lines.length}`);
console.log("RESULT allocations covering 0x99fcb60:");
for (const l of lines) if (l.startsWith("***")) console.log("  " + l);
console.log("RESULT allocations landing in 0x99000000-0x9a000000 (the collision zone):");
for (const l of lines) { const m = /0x(9[0-9a-f]{6})\.\./.exec(l); if (m && parseInt(m[1], 16) >= 0x9900000 && parseInt(m[1], 16) <= 0xa000000) console.log("  " + l); }
console.log("RESULT first 30 allocs:");
for (const l of lines.slice(0, 30)) console.log("  " + l);
