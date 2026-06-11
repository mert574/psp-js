/**
 * Benchmark frame execution and GE processing.
 * Usage: npx tsx tools/bench-frames.ts <iso-path> [frames=100]
 *
 * Reports per-frame timing breakdown: CPU, GE inline processing,
 * block transfers, and overall FPS.
 */

import { readFileSync, existsSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

Logger.minLevel = "warn";

const isoPath = process.argv[2];
const maxFrames = parseInt(process.argv[3] ?? "100", 10);

if (!isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/bench-frames.ts <iso-path> [frames]");
  process.exit(1);
}

function extractEboot(buf: ArrayBuffer): Uint8Array {
  const vol = parseIso(buf);
  const pg = vol.root.children!.find(f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
  const sd = pg.children!.find(f => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
  const eb = sd.children!.find(f => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!;
  return readFile(buf, eb).slice();
}

function mountIso(buf: ArrayBuffer, fileData: Map<string, Uint8Array>): void {
  const vol = parseIso(buf);
  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) {
      for (const child of node.children ?? []) walk(child, path + "/" + child.name);
    } else {
      fileData.set("disc0:" + path, readFile(buf, node));
    }
  }
  walk(vol.root, "");
}

async function main() {
  console.log(`Benchmark: ${isoPath} (${maxFrames} frames)\n`);

  const isoBuf = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(isoBuf);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) { console.error("Decryption failed!"); process.exit(1); }
    data = dec as Uint8Array<ArrayBuffer>;
  }

  const emu = new PSPEmulator();
  mountIso(isoBuf, emu.hle.fileData);
  await emu.loadElfBinary(data);

  // Warmup: run 10 frames
  for (let i = 0; i < 10 && !emu.halted; i++) emu.runFrame();

  // Benchmark
  const frameTimes: number[] = [];
  const geProcessor = emu.hle.geProcessor;

  const prevPrims = geProcessor?.totalPrimCount ?? 0;
  const prevClears = geProcessor?.totalClearCount ?? 0;
  const prevLists = geProcessor?.totalListCount ?? 0;

  const t0 = performance.now();

  for (let i = 0; i < maxFrames && !emu.halted; i++) {
    const ft0 = performance.now();
    emu.runFrame();
    frameTimes.push(performance.now() - ft0);
  }

  const totalMs = performance.now() - t0;
  const totalFrames = frameTimes.length;

  const totalPrims = (geProcessor?.totalPrimCount ?? 0) - prevPrims;
  const totalClears = (geProcessor?.totalClearCount ?? 0) - prevClears;
  const totalLists = (geProcessor?.totalListCount ?? 0) - prevLists;

  // Stats
  frameTimes.sort((a, b) => a - b);
  const avg = totalMs / totalFrames;
  const median = frameTimes[Math.floor(totalFrames / 2)]!;
  const p95 = frameTimes[Math.floor(totalFrames * 0.95)]!;
  const p99 = frameTimes[Math.floor(totalFrames * 0.99)]!;
  const min = frameTimes[0]!;
  const max = frameTimes[totalFrames - 1]!;

  console.log(`Frames: ${totalFrames}`);
  console.log(`Total: ${totalMs.toFixed(1)}ms`);
  console.log(`FPS: ${(totalFrames / (totalMs / 1000)).toFixed(1)}`);
  console.log(`\nFrame time (ms):`);
  console.log(`  avg:    ${avg.toFixed(2)}`);
  console.log(`  median: ${median.toFixed(2)}`);
  console.log(`  min:    ${min.toFixed(2)}`);
  console.log(`  max:    ${max.toFixed(2)}`);
  console.log(`  p95:    ${p95.toFixed(2)}`);
  console.log(`  p99:    ${p99.toFixed(2)}`);
  console.log(`\nGE (during benchmark):`);
  console.log(`  Lists: ${totalLists} (${(totalLists / totalFrames).toFixed(1)}/frame)`);
  console.log(`  Prims: ${totalPrims} (${(totalPrims / totalFrames).toFixed(1)}/frame)`);
  console.log(`  Clears: ${totalClears} (${(totalClears / totalFrames).toFixed(1)}/frame)`);
  console.log(`  Halted: ${emu.halted}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
