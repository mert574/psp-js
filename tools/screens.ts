/** Boot a game headless and dump display-FB PNGs at multiple frames, with scripted input.
 *  Usage: npx tsx tools/screens.ts <iso> --at 100,300,600 [--press f:Button[:hold]]... [--out /tmp/dir]
 *  Output: <out>/<iso-name>-f<frame>.png  (prints nonblack pixel count per shot) */
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import zlib from "node:zlib";
import { loadGame, PspButton } from "../test/helpers/boot-game.js";

const isoPath = process.argv[2]!;
let shots: number[] = [300];
let outDir = "/tmp/screens";
interface Press { start: number; end: number; buttons: number }
const presses: Press[] = [];
for (let i = 3; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--at" && process.argv[i + 1]) shots = process.argv[++i]!.split(",").map((s) => parseInt(s, 10));
  else if (a === "--out" && process.argv[i + 1]) outDir = process.argv[++i]!;
  else if (a === "--press" && process.argv[i + 1]) {
    const [f, btn, hold] = process.argv[++i]!.split(":");
    const bit = (PspButton as Record<string, number>)[btn!];
    if (!bit) { console.error(`unknown button ${btn}; valid: ${Object.keys(PspButton).join(" ")}`); process.exit(1); }
    presses.push({ start: parseInt(f!, 10), end: parseInt(f!, 10) + (hold ? parseInt(hold, 10) : 5), buttons: bit });
  }
}
shots.sort((a, b) => a - b);
mkdirSync(outDir, { recursive: true });

const W = 480, H = 272;
const emu = await loadGame(isoPath);
if (existsSync("public/flash0/font")) {
  for (const f of readdirSync("public/flash0/font")) {
    if (f.endsWith(".pgf")) emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
  }
}

function capture(): { raw: Buffer; nonblack: number } {
  const hk = emu.hle as any;
  const fbAddr = (hk.framebufAddr !== 0 ? hk.framebufAddr : hk.geFbAddr) >>> 0;
  const stride = hk.framebufWidth || 512;
  const fmt = hk.framebufFormat ?? 3;
  const vram = emu.bus.vramBuffer;
  const off = fbAddr - 0x04000000;
  const raw = Buffer.alloc(W * H * 4);
  let nonblack = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const di = (y * W + x) * 4;
      let r = 0, g = 0, b = 0;
      if (fmt === 3) {
        const src = off + (y * stride + x) * 4;
        r = vram[src + 2] ?? 0; g = vram[src + 1] ?? 0; b = vram[src] ?? 0;
      } else {
        const src = off + (y * stride + x) * 2;
        const px = (vram[src] ?? 0) | ((vram[src + 1] ?? 0) << 8);
        if (fmt === 0) { r = (px & 0x1f) << 3; g = ((px >> 5) & 0x3f) << 2; b = ((px >> 11) & 0x1f) << 3; }
        else if (fmt === 1) { r = (px & 0x1f) << 3; g = ((px >> 5) & 0x1f) << 3; b = ((px >> 10) & 0x1f) << 3; }
        else { r = (px & 0xf) << 4; g = ((px >> 4) & 0xf) << 4; b = ((px >> 8) & 0xf) << 4; }
      }
      raw[di] = r; raw[di + 1] = g; raw[di + 2] = b; raw[di + 3] = 255;
      if (r | g | b) nonblack++;
    }
  }
  return { raw, nonblack };
}

function png(rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = W * 4;
  const rows = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8); return c ^ 0xffffffff; }

const name = basename(isoPath).replace(/\.[^.]+$/, "");
const last = shots[shots.length - 1]!;
for (let f = 0; f <= last; f++) {
  let buttons = 0;
  for (const p of presses) if (f >= p.start && f < p.end) buttons |= p.buttons;
  emu.hle.inputSnapshot = () => ({ buttons, analog: { x: 0, y: 0 } });
  emu.runFrame();
  await Promise.resolve();
  if (shots.includes(f)) {
    const { raw, nonblack } = capture();
    const out = join(outDir, `${name}-f${f}.png`);
    writeFileSync(out, png(raw));
    console.log(`f=${f} nonblack=${nonblack}/${W * H} → ${out}`);
  }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`HALTED at frame ${f}`); break; }
}
