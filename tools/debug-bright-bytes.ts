/** Find the brightest framebuffer pixels and print their channel bytes. */
import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame(process.argv[2]!);
const frames = parseInt(process.argv[3] ?? "120", 10);
for (let f = 0; f < frames; f++) { emu.runFrame(); await Promise.resolve(); }
const hk = emu.hle as any;
const vram = emu.bus.vramBuffer;
const off = (hk.framebufAddr >>> 0) - 0x04000000;
const stride = hk.framebufWidth || 512;
const fmt = hk.framebufFormat;
console.log(`fmt=${fmt} stride=${stride}`);
type P = { x: number; y: number; r: number; g: number; b: number; sum: number };
const top: P[] = [];
for (let y = 0; y < 272; y++) for (let x = 0; x < 480; x++) {
  let r, g, b;
  if (fmt === 3) { const s = off + (y * stride + x) * 4; r = vram[s]!; g = vram[s+1]!; b = vram[s+2]!; }
  else { const s = off + (y * stride + x) * 2; const px = vram[s]! | (vram[s+1]! << 8); r = (px & 0x1f) << 3; g = ((px>>5)&0x3f)<<2; b = ((px>>11)&0x1f)<<3; }
  const sum = r + g + b;
  if (sum > 200 && (r !== g || g !== b)) { // colorful, not gray
    top.push({ x, y, r, g, b, sum });
  }
}
top.sort((a, b) => b.sum - a.sum);
const seen = new Set<string>();
let shown = 0;
for (const p of top) {
  const k = `${p.r},${p.g},${p.b}`;
  if (seen.has(k)) continue; seen.add(k);
  console.log(`(${p.x},${p.y}) byte0=${p.r} byte1=${p.g} byte2=${p.b}  ${p.r>p.b?"RED/amber-dominant":"BLUE-dominant"} in byte0`);
  if (++shown >= 8) break;
}
