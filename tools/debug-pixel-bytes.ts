/** Read raw framebuffer bytes at given pixels to determine channel order.
 *  Usage: npx tsx tools/debug-pixel-bytes.ts <iso> <frames> x,y x,y ... */
import { loadGame } from "../test/helpers/boot-game.js";

const iso = process.argv[2]!;
const frames = parseInt(process.argv[3]!, 10);
const pts = process.argv.slice(4).map((s) => s.split(",").map(Number));

const emu = await loadGame(iso);
for (let f = 0; f < frames; f++) { emu.runFrame(); await Promise.resolve(); }
const hk = emu.hle as any;
const vram = emu.bus.vramBuffer;
const off = (hk.framebufAddr >>> 0) - 0x04000000;
const stride = hk.framebufWidth || 512;
const fmt = hk.framebufFormat;
console.log(`fmt=${fmt} stride=${stride} fbAddr=0x${(hk.framebufAddr>>>0).toString(16)}`);
for (const [x, y] of pts) {
  const s = off + (y! * stride + x!) * (fmt === 3 ? 4 : 2);
  if (fmt === 3) {
    console.log(`(${x},${y}) byte0=${vram[s]} byte1=${vram[s+1]} byte2=${vram[s+2]} byte3=${vram[s+3]}  (if byte0=R it's amber, if byte2=R it's blue)`);
  } else {
    const px = (vram[s] ?? 0) | ((vram[s+1] ?? 0) << 8);
    console.log(`(${x},${y}) px=0x${px.toString(16)} lowBits=${px & 0x1f} highBits=${(px>>11)&0x1f}`);
  }
}
