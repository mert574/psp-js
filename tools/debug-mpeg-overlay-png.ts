/** Render a sample MPEG overlay frame to PNG to preview the text look.
 *  Usage: npx tsx tools/debug-mpeg-overlay-png.ts [out.png] */
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { drawText, textWidth, GLYPH_H } from "../src/gpu/text-overlay.js";

const out = process.argv[2] ?? "/tmp/mpeg-overlay.png";
const W = 480, H = 272;
const VRAM = 0x04000000;
const bus = MemoryBus.create();

// Opaque-black frame, then the same labels sceMpegAvcDecode draws (8888).
for (let i = 0; i < W * H; i++) bus.writeU32(VRAM + i * 4, 0xff000000);
const name = "OPENING.PMF";
const info = "480X272  1/900";
const scale = 2;
const ty = (H >> 1) - GLYPH_H * scale;
drawText(bus, VRAM, W, H, 3, (W - textWidth(name, scale)) >> 1, ty, name, scale);
drawText(bus, VRAM, W, H, 3, (W - textWidth(info, scale)) >> 1, ty + GLYPH_H * scale + scale * 2, info, scale, [160, 160, 160, 255]);

// VRAM is ABGR8888; PNG wants RGBA.
const raw = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const v = bus.readU32(VRAM + i * 4) >>> 0;
  raw[i * 4] = v & 0xff;            // R
  raw[i * 4 + 1] = (v >>> 8) & 0xff;  // G
  raw[i * 4 + 2] = (v >>> 16) & 0xff; // B
  raw[i * 4 + 3] = (v >>> 24) & 0xff; // A
}
// Minimal PNG encode.
const lines = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  lines[y * (W * 4 + 1)] = 0;
  raw.copy(lines, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(lines);
const crc = (buf: Buffer): number => {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H})`);
