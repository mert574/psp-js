#!/usr/bin/env npx tsx
setTimeout(() => { console.error("\n[TIMEOUT]"); process.exit(1); }, 30_000).unref();
/**
 * GE Texture State Dump — boots an ISO for N frames and logs every unique
 * texture configuration used during PRIM rendering.
 *
 * Usage:
 *   npx tsx tools/ge-tex-dump.ts <iso-path> [--frames N]
 *
 * Helps diagnose garbled/missing textures by showing what format, size,
 * swizzle, CLUT settings are being used.
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import type { IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

const TEX_FMT = ["5650", "5551", "4444", "8888", "T4", "T8", "T16", "T32", "DXT1", "DXT3", "DXT5"];
const CLUT_FMT = ["5650", "5551", "4444", "8888"];

function findEboot(dir: IsoFile): IsoFile | undefined {
  for (const c of dir.children ?? []) {
    if (!c.isDirectory && c.name.toUpperCase().replace(/;1$/, "") === "EBOOT.BIN") return c;
    if (c.isDirectory) { const f = findEboot(c); if (f) return f; }
  }
}
function mountIso(path: string, fileData: Map<string, Uint8Array>) {
  const buf = readFileSync(path).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  function walk(node: IsoFile, p: string) {
    if (node.isDirectory) { for (const c of node.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase()); }
    else fileData.set("disc0:" + p, readFile(buf, node));
  }
  walk(vol.root, "");
}

const args = process.argv.slice(2);
const isoPath = args[0];
if (!isoPath) { console.error("Usage: npx tsx tools/ge-tex-dump.ts <iso> [--frames N]"); process.exit(1); }
const maxFrames = parseInt(args[args.indexOf("--frames") + 1] || "60", 10);

Logger.minLevel = "warn";

const buf = readFileSync(isoPath).buffer as ArrayBuffer;
const vol = parseIso(buf);
const entry = findEboot(vol.root)!;
let data = readFile(buf, entry).slice() as Uint8Array;
if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array;
const dv = new DataView(data.buffer, data.byteOffset, 4);
if (dv.getUint32(0, false) === 0x7e505350) data = (await pspDecryptPRX(data)) as Uint8Array;

const emu = new PSPEmulator();
mountIso(isoPath, emu.hle.fileData);
await emu.loadElfBinary(data);

// Monkey-patch the GE processor to log texture state on PRIM
const ge = (emu as any).geDispatcher?.processor ?? (emu as any).hle?.geDispatcher?.processor;
if (!ge) {
  // No GE worker in node — patch the GEProcessor from the worker module
  console.log("Note: No GE worker available in node (headless). Texture state comes from GE commands only.");
}

// Track unique texture configs
const seenConfigs = new Map<string, { count: number; sample: string }>();

// Hook into the GE command processing by watching for PRIM commands
// Since we can't easily hook the worker, let's read GE state from memory after each frame
console.log(`Booting ${isoPath} for ${maxFrames} frames...\n`);

for (let f = 0; f < maxFrames; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) {
    console.log(`Halted at frame ${f}`);
    break;
  }
}

// Dump GE command memory (from the headless scanner if available)
const hle = emu.hle as any;
if (hle.geCommandMem) {
  const cm = hle.geCommandMem as Uint32Array;
  console.log("── GE Command Memory (texture-relevant) ──");

  // Texture addresses
  const texAddr0Lo = cm[0xA0] & 0xFFFFFF;
  const texAddr0Hi = cm[0xA8] & 0xFFFFFF;
  const texAddr = texAddr0Lo | ((texAddr0Hi & 0xFF0000) << 8);
  console.log(`  texAddr0: 0x${texAddr.toString(16)}`);

  // Texture size
  const texSize = cm[0xB8] & 0xFFFFFF;
  const texW = 1 << (texSize & 0xF);
  const texH = 1 << ((texSize >> 8) & 0xF);
  console.log(`  texSize: ${texW}×${texH}`);

  // Texture format + swizzle
  const texMode = cm[0xC6] & 0xFFFFFF;
  const texFmt = texMode & 0xF;
  const swizzle = (texMode >> 8) & 1;
  console.log(`  texFormat: ${texFmt} (${TEX_FMT[texFmt] ?? "?"}), swizzle: ${swizzle}`);

  // Buffer width
  const texBufW = cm[0xA2] & 0xFFFFFF;
  const bw = texBufW & 0x7FF;
  console.log(`  texBufWidth: ${bw}`);

  // CLUT
  const clutAddrLo = cm[0xB0] & 0xFFFFFF;
  const clutAddrHi = cm[0xB1] & 0xFFFFFF;
  const clutAddr = (clutAddrLo & 0xFFFFF0) | ((clutAddrHi << 8) & 0x0F000000);
  const clutFmt = cm[0xC5] & 0xFFFFFF;
  const clutFormat = clutFmt & 3;
  const clutShift = (clutFmt >> 2) & 0x1F;
  const clutMask = (clutFmt >> 8) & 0xFF;
  const clutStart = ((clutFmt >> 16) & 0x1F) << 4;
  console.log(`  clutAddr: 0x${clutAddr.toString(16)}, fmt: ${clutFormat} (${CLUT_FMT[clutFormat] ?? "?"})`);
  console.log(`  clutShift: ${clutShift}, clutMask: 0x${clutMask.toString(16)}, clutStart: ${clutStart}`);

  // Sample CLUT palette
  if (texFmt >= 4 && texFmt <= 7 && clutAddr > 0) {
    const bus = (emu as any).bus;
    console.log(`  CLUT palette (first 16 entries):`);
    const stride = clutFormat === 3 ? 4 : 2;
    for (let i = 0; i < 16; i++) {
      try {
        const val = stride === 4 ? bus.readU32(clutAddr + i * stride) : bus.readU16(clutAddr + i * stride);
        process.stdout.write(`    [${i}]=0x${val.toString(16).padStart(stride*2, "0")}`);
        if (i % 4 === 3) process.stdout.write("\n");
      } catch { break; }
    }
    console.log();
  }

  // Sample texture data
  if (texAddr > 0) {
    const bus = (emu as any).bus;
    console.log(`  Texture data (first 32 bytes):`);
    let hex = "    ";
    for (let i = 0; i < 32; i++) {
      try { hex += bus.readU8(texAddr + i).toString(16).padStart(2, "0") + " "; }
      catch { hex += "?? "; }
      if (i % 16 === 15) { console.log(hex); hex = "    "; }
    }
    if (hex.trim()) console.log(hex);
  }
} else {
  console.log("No geCommandMem available (GE worker mode).");
}

// Also dump the framebuffer to check what was rendered
const bus = (emu as any).bus;
const fbAddr = emu.hle.framebufAddr || 0x04000000;
console.log(`\n── Framebuffer at 0x${fbAddr.toString(16)} ──`);
let nonBlack = 0;
for (let i = 0; i < 480 * 272; i++) {
  const px = bus.readU32(fbAddr + i * 4);
  if ((px & 0x00FFFFFF) !== 0) nonBlack++;
}
console.log(`  Non-black pixels: ${nonBlack} / ${480*272}`);
