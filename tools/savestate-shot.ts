/**
 * Restore a .pspstate headless, run a capped number of frames, and dump the
 * software framebuffer to a PNG so we can inspect a screen without the browser.
 *
 * Usage: npx tsx tools/savestate-shot.ts <state-file> <iso-path> [frames=4] [out.png]
 *
 * Frames are hard-capped at 10 on purpose: this is a debugging aid for looking
 * at one screen, not for advancing gameplay. Pass a small number.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
import { PSPEmulator } from "../src/emulator.js";
import { unpackContainer } from "../src/state/state-container.js";
import { extractEboot, mountIso } from "./iso-mount.js";
import { Logger } from "../src/utils/logger.js";

const stateFile = process.argv[2];
const isoPath = process.argv[3];
const FRAME_CAP = 10;
const frames = Math.min(parseInt(process.argv[4] ?? "4", 10), FRAME_CAP);
const out = process.argv[5] ?? "/tmp/savestate-shot.png";
// Optional crop+upscale: CROP=x,y,w,h,scale (e.g. CROP=260,36,120,24,6)
const cropEnv = process.env.CROP;
const crop = cropEnv ? cropEnv.split(",").map(Number) : null;

if (!stateFile || !existsSync(stateFile) || !isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/savestate-shot.ts <state-file> <iso-path> [frames<=10] [out.png]");
  process.exit(1);
}

async function main(): Promise<void> {
  const blob = new Uint8Array(readFileSync(stateFile));
  const header = await unpackContainer(blob);
  console.log(`State: ${header.gameId} v${header.formatVersion} eboot=0x${header.contentHash.toString(16)}`);

  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  const eboot = extractEboot(isoBuffer);

  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);

  // Register flash0 fonts like the browser, so sceFont text renders.
  if (existsSync("public/flash0/font")) {
    for (const f of readdirSync("public/flash0/font")) {
      if (f.endsWith(".pgf"))
        emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`public/flash0/font/${f}`)));
    }
  }

  const errors: string[] = [];
  Logger.setErrorHook((ns, msg) => errors.push(`[${ns}] ${msg}`));

  await emu.loadElfBinary(eboot);
  await emu.loadState(blob, { allowBuildMismatch: process.argv.includes("--force") });
  console.log(`Restored. PC=0x${emu.cpu.regs.pc.toString(16)} threads=${emu.hle.threads.size}`);

  for (let i = 0; i < frames; i++) {
    emu.runFrame();
    await Promise.resolve();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }

  const hk = emu.hle as any;
  const fbAddr = hk.framebufAddr !== 0 ? hk.framebufAddr : hk.geFbAddr;
  const stride = hk.framebufWidth || 512;
  const fmt = hk.framebufFormat;
  const W = 480, H = 272;
  const vram = emu.bus.vramBuffer;
  const off = (fbAddr >>> 0) - 0x04000000;
  console.log(`fbAddr=0x${(fbAddr >>> 0).toString(16)} stride=${stride} fmt=${fmt}`);

  const bpp = fmt === 3 ? 4 : 2;
  const view = new DataView(vram.buffer, vram.byteOffset);
  const raw = Buffer.alloc(W * H * 4);
  let nonblack = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = off + (y * stride + x) * bpp;
      let r = 0, g = 0, b = 0;
      if (fmt === 3) {
        r = vram[src] ?? 0; g = vram[src + 1] ?? 0; b = vram[src + 2] ?? 0;
      } else {
        const px = view.getUint16(src, true);
        if (fmt === 0) { // BGR5650
          r = (px & 0x1f) << 3; g = ((px >>> 5) & 0x3f) << 2; b = ((px >>> 11) & 0x1f) << 3;
        } else if (fmt === 1) { // ABGR5551
          r = (px & 0x1f) << 3; g = ((px >>> 5) & 0x1f) << 3; b = ((px >>> 10) & 0x1f) << 3;
        } else { // ABGR4444
          r = (px & 0xf) << 4; g = ((px >>> 4) & 0xf) << 4; b = ((px >>> 8) & 0xf) << 4;
        }
      }
      const di = (y * W + x) * 4;
      raw[di] = r; raw[di + 1] = g; raw[di + 2] = b; raw[di + 3] = 255;
      if (r | g | b) nonblack++;
    }
  }
  console.log(`nonblack=${nonblack}/${W * H}`);

  if (crop) {
    const [cx, cy, cw, ch, sc] = crop as [number, number, number, number, number];
    const ow = cw * sc, oh = ch * sc;
    const cropped = Buffer.alloc(ow * oh * 4);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const sx = cx + Math.floor(x / sc), sy = cy + Math.floor(y / sc);
        const si = (sy * W + sx) * 4, di = (y * ow + x) * 4;
        cropped[di] = raw[si]!; cropped[di + 1] = raw[si + 1]!; cropped[di + 2] = raw[si + 2]!; cropped[di + 3] = 255;
      }
    }
    writeFileSync(out, png(ow, oh, cropped));
    console.log(`wrote ${out} (crop ${cx},${cy} ${cw}x${ch} @${sc}x)`);
  } else {
    writeFileSync(out, png(W, H, raw));
    console.log(`wrote ${out}`);
  }
  if (errors.length) {
    console.log(`errors (${errors.length}):`);
    for (const e of errors.slice(0, 15)) console.log(`  ${e}`);
  }
}

function png(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride2 = width * 4;
  const rows = Buffer.alloc((stride2 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride2 + 1)] = 0;
    rgba.copy(rows, y * (stride2 + 1) + 1, y * stride2, (y + 1) * stride2);
  }
  const idat = zlib.deflateSync(rows);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8); return c ^ 0xffffffff; }

main().catch((err) => { console.error(err); process.exit(1); });
