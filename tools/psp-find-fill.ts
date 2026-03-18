#!/usr/bin/env npx tsx
// Auto-timeout
setTimeout(() => { console.error("\n[TIMEOUT]"); process.exit(1); }, 30_000).unref();
/**
 * Find which frame first writes non-zero data to a given address.
 */
import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import type { IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

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
async function loadEboot(isoPath: string): Promise<Uint8Array> {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  const entry = findEboot(vol.root)!;
  let data = readFile(buf, entry).slice() as Uint8Array;
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array;
  const v = new DataView(data.buffer, data.byteOffset, 4);
  if (v.getUint32(0, false) === 0x7e505350) data = (await pspDecryptPRX(data)) as Uint8Array;
  return data;
}

Logger.minLevel = "error";
const data = await loadEboot("test/fixtures/space-invaders.iso");
const emu = new PSPEmulator();
mountIso("test/fixtures/space-invaders.iso", emu.hle.fileData);
await emu.loadElfBinary(data);

const watchAddr = 0x09742400;

let prevVal = 0;
for (let f = 0; f < 60; f++) {
  emu.runFrame(2_000_000);
  const val = emu.bus.readU32(watchAddr);
  if (val !== prevVal) {
    const is63 = val === 0x63636363;
    console.log(`Frame ${f}: [0x${watchAddr.toString(16)}] changed to 0x${val.toString(16).padStart(8, "0")}${is63 ? " ← 0x63 FILL!" : ""}`);
    prevVal = val;
  }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`Stopped at frame ${f + 1}`); break; }
}
