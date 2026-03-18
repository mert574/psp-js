/**
 * Boot an ISO for N frames and report diagnostics.
 * Usage: npx tsx tools/boot-iso.ts <iso-path> [frames=300]
 */

import { readFileSync, existsSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

const isoPath = process.argv[2];
const maxFrames = parseInt(process.argv[3] ?? "300", 10);

if (!isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/boot-iso.ts <iso-path> [frames]");
  process.exit(1);
}

function extractEboot(isoBuffer: ArrayBuffer): Uint8Array {
  const volume = parseIso(isoBuffer);
  const pspGame = volume.root.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  )!;
  const sysdir = pspGame.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR"
  )!;
  const eboot = sysdir.children!.find(
    (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN"
  )!;
  return readFile(isoBuffer, eboot).slice();
}

function mountIso(isoBuffer: ArrayBuffer, fileData: Map<string, Uint8Array>): void {
  const volume = parseIso(isoBuffer);
  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) {
      for (const child of node.children ?? []) {
        walk(child, path + "/" + child.name.replace(/;1$/, "").toLowerCase());
      }
    } else {
      fileData.set("disc0:" + path, readFile(isoBuffer, node));
    }
  }
  walk(volume.root, "");
}

async function main() {
  console.log(`\n=== Booting: ${isoPath} (${maxFrames} frames) ===\n`);

  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(isoBuffer);
  console.log(`EBOOT.BIN: ${data.byteLength} bytes`);

  if (isPbp(data)) {
    data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
    console.log(`PBP unwrapped: ${data.byteLength} bytes`);
  }

  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    console.log("Encrypted PRX, decrypting...");
    const dec = await pspDecryptPRX(data);
    if (!dec) { console.error("Decryption failed!"); process.exit(1); }
    data = dec as Uint8Array<ArrayBuffer>;
    console.log(`Decrypted: ${data.byteLength} bytes`);
  }

  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);

  // Capture errors and warnings
  const errors: string[] = [];
  const warnings: string[] = [];
  Logger.setErrorHook((ns, msg) => errors.push(`[${ns}] ${msg}`));
  Logger.setWarnHook((_level, ns, msg) => {
    if (warnings.length < 50) warnings.push(`[${ns}] ${msg}`);
  });

  // Spy on sceGeListEnQueue (NID 0xab49e76a)
  let geEnqueueCount = 0;
  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs: any) => {
    const nid = emu.hle.getNidBySyscallForTest(code);
    if (nid === 0xab49e76a) geEnqueueCount++;
    origDispatch(code, regs);
  };

  await emu.loadElfBinary(data);
  console.log(`Entry: 0x${emu.cpu.regs.pc.toString(16)}`);

  let frames = 0;
  const startTime = Date.now();

  for (frames = 0; frames < maxFrames; frames++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }

  const elapsed = Date.now() - startTime;
  const pc = emu.cpu.regs.pc;

  console.log(`\n--- Results ---`);
  console.log(`Frames: ${frames}/${maxFrames}`);
  console.log(`Time: ${elapsed}ms (${(frames / (elapsed / 1000)).toFixed(1)} fps)`);
  console.log(`PC: 0x${pc.toString(16)}`);
  console.log(`Halted: ${emu.halted}, Faulted: ${emu.cpu.stepFaulted}`);
  console.log(`VBlank count: ${emu.hle.vblankCount}`);
  console.log(`GE lists: ${emu.hle.geListCount}, prims: ${emu.hle.gePrimCount}, geEnqueue calls: ${geEnqueueCount}`);
  console.log(`Threads: ${emu.hle.threads.size}`);

  // Stub calls
  if (emu.hle.stubCalls.size > 0) {
    const sorted = [...emu.hle.stubCalls.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nStub calls (${sorted.length} unique):`);
    for (const [name, count] of sorted.slice(0, 20)) {
      console.log(`  ${name}: ${count}`);
    }
    if (sorted.length > 20) console.log(`  ... and ${sorted.length - 20} more`);
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 20)) console.log(`  ${w}`);
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }

  if (errors.length > 0) {
    console.log(`\nERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  ${e}`);
  }

  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
