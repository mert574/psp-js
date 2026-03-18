#!/usr/bin/env npx tsx
// Auto-timeout: kill process after 30 seconds to prevent hangs
setTimeout(() => { console.error("\n[TIMEOUT] 30s limit reached"); process.exit(1); }, 30_000).unref();
/**
 * Traces the t5 command-buffer write pointer over time to understand
 * why it overflows into BSS, and watches the function pointer that gets zeroed.
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
  if (v.getUint32(0, false) === 0x7e505350) { data = (await pspDecryptPRX(data)) as Uint8Array; }
  return data;
}

Logger.minLevel = "error";

const data = await loadEboot("test/fixtures/space-invaders.iso");
const emu = new PSPEmulator();
mountIso("test/fixtures/space-invaders.iso", emu.hle.fileData);
Logger.setErrorHook((ns, msg) => console.log(`[${ns}] ${msg}`));

// Track writes to the t5 buffer area (function pointer table zone)
// We know 0x8a065f4 gets zeroed — watch a 128-byte range around it
const WATCH_BASE = 0x8a065c0;
const WATCH_END  = 0x8a06640;
let fpWriteLog: {pc: number, addr: number, val: number}[] = [];

const origWriteU32 = emu.bus.writeU32.bind(emu.bus);
(emu.bus as any).writeU32 = function(vaddr: number, value: number) {
  const phys = vaddr & 0x1FFFFFFF;
  if (phys >= WATCH_BASE && phys < WATCH_END) {
    fpWriteLog.push({ pc: emu.cpu.regs.pc, addr: phys, val: value });
  }
  return origWriteU32(vaddr, value);
};

// Track ALL calls to 0x889f4e0 and log t5 range over time
// Only log periodically to avoid flooding
let callCount = 0;
const T5_SAMPLES: {frame:number, t5:number, t5min:number, t5max:number}[] = [];
let t5min = Infinity, t5max = 0;

const origStep = emu.cpu.step.bind(emu.cpu);
let currentFrame = 0;
emu.cpu.step = function() {
  const pc = emu.cpu.regs.pc;
  if (pc === 0x889f4e0) {
    callCount++;
    const t5 = emu.cpu.regs.getGpr(13); // $t5
    if (t5 < t5min) t5min = t5;
    if (t5 > t5max) t5max = t5;
  }
  return origStep();
};

await emu.loadElfBinary(data);

for (let f = 0; f < 100; f++) {
  currentFrame = f;
  emu.runFrame(2_000_000);
  if (t5min < Infinity) {
    T5_SAMPLES.push({ frame: f, t5: emu.cpu.regs.getGpr(13), t5min, t5max });
  }
  t5min = Infinity; t5max = 0;
  if (emu.halted || emu.cpu.stepFaulted) {
    console.log(`Stopped at frame ${f + 1}`);
    break;
  }
}

console.log(`\n=== t5 write-ptr samples (0x889f4e0 calls) ===`);
for (const s of T5_SAMPLES) {
  console.log(`  frame=${s.frame} t5_range=[0x${s.t5min.toString(16)}, 0x${s.t5max.toString(16)}]`);
}
console.log(`Total calls to 0x889f4e0: ${callCount}`);

console.log(`\n=== Writes to 0x${WATCH_BASE.toString(16)}..0x${WATCH_END.toString(16)} (function ptr zone) ===`);
for (const w of fpWriteLog) {
  console.log(`  PC=0x${w.pc.toString(16)} addr=0x${w.addr.toString(16)} val=0x${w.val.toString(16).padStart(8,"0")}`);
}

console.log(`\nPC=0x${emu.cpu.regs.pc.toString(16)} halted=${emu.halted} faulted=${emu.cpu.stepFaulted}`);
