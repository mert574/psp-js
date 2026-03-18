#!/usr/bin/env npx tsx
// Auto-timeout: kill process after 30 seconds to prevent hangs
setTimeout(() => { console.error("\n[TIMEOUT] 30s limit reached"); process.exit(1); }, 30_000).unref();
/**
 * Watches for a specific register to change to a target value.
 * Usage: npx tsx tools/psp-watch-reg.ts [--reg N] [--value 0xHEX] [--pc-range 0xLO-0xHI]
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

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const isoPath = getArg("--iso") ?? "test/fixtures/space-invaders.iso";
const regIdx = parseInt(getArg("--reg") ?? "22"); // $s6 = reg 22
const targetValue = parseInt(getArg("--value") ?? "0x6363", 16);
const frames = parseInt(getArg("--frames") ?? "60");
const pcRange = getArg("--pc-range");
const pcLo = pcRange ? parseInt(pcRange.split("-")[0]!, 16) : 0;
const pcHi = pcRange ? parseInt(pcRange.split("-")[1]!, 16) : 0xFFFFFFFF;

Logger.minLevel = "error";
const data = await loadEboot(isoPath);
const emu = new PSPEmulator();
mountIso(isoPath, emu.hle.fileData);

const gprNames = ["zr","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];

let prevVal = 0;
let found = false;
const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function () {
  const pc = emu.cpu.regs.pc;
  const result = origStep();
  const newVal = emu.cpu.regs.getGpr(regIdx);
  if (newVal === targetValue && prevVal !== targetValue && pc >= pcLo && pc <= pcHi) {
    const r = emu.cpu.regs;
    console.log(`\n[WATCH] $${gprNames[regIdx]} changed to 0x${targetValue.toString(16)} at PC=0x${pc.toString(16)}`);
    console.log(`  prev=0x${prevVal.toString(16)} → new=0x${newVal.toString(16)}`);
    const regs = gprNames.map((n, i) => `${n}=0x${r.getGpr(i).toString(16)}`).join(" ");
    console.log(`  ${regs}`);

    // Dump instruction at PC
    try {
      const instr = emu.bus.readU32(pc);
      console.log(`  instruction: 0x${instr.toString(16).padStart(8, "0")}`);
    } catch { /* ignore */ }
    found = true;
  }
  prevVal = newVal;
  return result;
};

await emu.loadElfBinary(data);

console.log(`Watching $${gprNames[regIdx]} for value 0x${targetValue.toString(16)} (frames=${frames})`);

for (let f = 0; f < frames; f++) {
  emu.runFrame(2_000_000);
  if (found) { console.log(`Found in frame ${f}`); break; }
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`Stopped at frame ${f + 1}`); break; }
}

if (!found) console.log("Value not found");
console.log(`PC=0x${emu.cpu.regs.pc.toString(16)} halted=${emu.halted} faulted=${emu.cpu.stepFaulted}`);
