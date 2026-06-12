/** Scan all of VRAM for nonzero regions after booting puyo-puyo.
 *  Usage: npx tsx tools/debug-puyo-vram.ts <iso> [frames] */
import { loadGame } from "../test/helpers/boot-game.js";

const iso = process.argv[2] ?? "public/puyo-puyo.iso";
const frames = parseInt(process.argv[3] ?? "400", 10);

const emu = await loadGame(iso);
for (let i = 0; i < frames; i++) { emu.runFrame(); await Promise.resolve(); }

const hk = emu.hle as any;
console.log(`framebufAddr=0x${(hk.framebufAddr>>>0).toString(16)} geFbAddr=0x${(hk.geFbAddr>>>0).toString(16)} fmt=${hk.framebufFormat} stride=${hk.framebufWidth}`);

const vram = emu.bus.vramBuffer;
// scan in 64KB chunks
for (let base = 0; base < vram.length; base += 0x10000) {
  let nz = 0;
  for (let i = 0; i < 0x10000; i++) if (vram[base + i] !== 0) nz++;
  if (nz > 0) console.log(`VRAM +0x${base.toString(16).padStart(6,"0")} (0x${(0x04000000+base).toString(16)}): ${nz} nonzero bytes`);
}
