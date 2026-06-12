/** Boot a game (software raster) and dump the display framebuffer to a PNG.
 *  Usage: npx tsx tools/debug-fb-png.ts <iso> [frames] [out.png] */
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { loadGame } from "../test/helpers/boot-game.js";
import zlib from "node:zlib";

const iso = process.argv[2] ?? "public/cladun-rpg.iso";
const frames = parseInt(process.argv[3] ?? "350", 10);
const out = process.argv[4] ?? "/tmp/fb.png";

const emu = await loadGame(iso);
// Register flash0 fonts like the browser
if (existsSync("public/flash0/font")) {
  for (const f of readdirSync("public/flash0/font")) {
    if (f.endsWith(".pgf")) emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
  }
}
for (let i = 0; i < frames; i++) { emu.runFrame(); await Promise.resolve(); }

const hk = emu.hle as any;
const fbAddr = hk.framebufAddr !== 0 ? hk.framebufAddr : hk.geFbAddr;
const stride = hk.framebufWidth || 512;
const W = 480, H = 272;
const vram = emu.bus.vramBuffer;
const off = (fbAddr >>> 0) - 0x04000000;
console.log(`fbAddr=0x${(fbAddr>>>0).toString(16)} stride=${stride} fmt=${hk.framebufFormat}`);

// Build RGBA raw (assume 8888)
const raw = Buffer.alloc(W * H * 4);
let nonblack = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const src = off + (y * stride + x) * 4;
    const r = vram[src] ?? 0, g = vram[src+1] ?? 0, b = vram[src+2] ?? 0;
    const di = (y * W + x) * 4;
    raw[di] = r; raw[di+1] = g; raw[di+2] = b; raw[di+3] = 255;
    if (r|g|b) nonblack++;
  }
}
console.log(`nonblack=${nonblack}/${W*H}`);

// Minimal PNG encoder
function png(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride2 = width * 4;
  const rows = Buffer.alloc((stride2 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride2 + 1)] = 0;
    rgba.copy(rows, y * (stride2 + 1) + 1, y * stride2, (y + 1) * stride2);
  }
  const idat = zlib.deflateSync(rows);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;} return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i=0;i<buf.length;i++) c = CRC_T[(c^buf[i]!)&0xff]! ^ (c>>>8); return c ^ 0xffffffff; }

writeFileSync(out, png(W, H, raw));
console.log(`wrote ${out}`);
