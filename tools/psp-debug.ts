#!/usr/bin/env npx tsx
// Auto-timeout: kill process after 30 seconds to prevent hangs
setTimeout(() => { console.error("\n[TIMEOUT] 30s limit reached"); process.exit(1); }, 30_000).unref();

/**
 * PSP Debug CLI — one-liner ISO loader and state inspector.
 *
 * Usage:
 *   npx tsx tools/psp-debug.ts <iso|elf> [options]
 *
 * Options:
 *   --frames <n>        Run N frames (default: 60)
 *   --steps <n>         Steps per frame (default: 2_000_000)
 *   --mem <addr> [len]  Hex-dump memory at addr (default 64 bytes)
 *   --disasm <addr> [n] Disassemble N words at addr (default 16)
 *   --watch <addr>      Watch writes to address
 *   --ge-signal         Log GE SIGNAL commands
 *   --silent            Suppress [HLE] / [GE] info logs
 *   --errors-only       Only show log.error output
 *   --dump-ge           Dump GE state after run
 *   --ring-buf <addr> <size>  Dump ring buffer contents
 *
 * Examples:
 *   npx tsx tools/psp-debug.ts test/fixtures/space-invaders.iso --frames 10
 *   npx tsx tools/psp-debug.ts test/fixtures/space-invaders.iso --mem 0x8a137ec 128
 *   npx tsx tools/psp-debug.ts test/fixtures/space-invaders.iso --watch 0x8a137f4
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import type { IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isoPath = args[0];

if (!isoPath || isoPath === "--help" || isoPath === "-h") {
  console.log("Usage: npx tsx tools/psp-debug.ts <iso-path> [options]");
  console.log("  --frames <n>         Run N frames (default 60)");
  console.log("  --steps <n>          Steps per frame (default 2_000_000)");
  console.log("  --mem <addr> [len]   Hex-dump memory (default 64 bytes)");
  console.log("  --disasm <addr> [n]  Disassemble N words (default 16)");
  console.log("  --watch <addr>       Watch writes to address");
  console.log("  --silent             Suppress info logs");
  console.log("  --errors-only        Only show errors");
  console.log("  --dump-ge            Dump GE state after run");
  process.exit(0);
}

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(flag: string): boolean { return args.includes(flag); }

const frames     = parseInt(getArg("--frames") ?? "60");
const stepsPerFr = parseInt(getArg("--steps")  ?? "2000000");
const memAddr    = getArg("--mem");
const memLen     = memAddr ? parseInt(args[args.indexOf("--mem") + 2] ?? "64") : 0;
const disasmAddr = getArg("--disasm");
const disasmN    = disasmAddr ? parseInt(args[args.indexOf("--disasm") + 2] ?? "16") : 0;
const watchAddr  = getArg("--watch");
const dumpGe     = hasFlag("--dump-ge");
const silent     = hasFlag("--silent");
const errorsOnly = hasFlag("--errors-only");

// ── Logging config ───────────────────────────────────────────────────────────

if (errorsOnly) {
  Logger.minLevel = "error";
} else if (silent) {
  Logger.minLevel = "warn";
}

// ── ISO/ELF loading ──────────────────────────────────────────────────────────

async function loadBinary(path: string): Promise<Uint8Array> {
  const raw = readFileSync(path);
  const buf = raw.buffer as ArrayBuffer;

  // ELF direct
  const magic = new DataView(buf).getUint32(0, false);
  if (magic === 0x7f454c46) return new Uint8Array(buf);

  // ISO
  const volume = parseIso(buf);
  function findFile(dir: IsoFile, name: string): IsoFile | undefined {
    for (const c of dir.children ?? []) {
      if (!c.isDirectory && c.name.toUpperCase().replace(/;1$/, "") === name) return c;
      if (c.isDirectory) { const f = findFile(c, name); if (f) return f; }
    }
  }
  const ebootEntry = findFile(volume.root, "EBOOT.BIN");
  if (!ebootEntry) throw new Error("EBOOT.BIN not found in ISO");
  let data: Uint8Array = readFile(buf, ebootEntry).slice() as Uint8Array;
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array;

  const view2 = new DataView(data.buffer, data.byteOffset, 4);
  if (view2.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) throw new Error("PRX decryption failed");
    data = dec as Uint8Array;
  }
  return data;
}

function mountIso(isoPath: string, fileData: Map<string, Uint8Array>): void {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  function walk(node: IsoFile, path: string) {
    if (node.isDirectory) {
      for (const c of node.children ?? []) walk(c, path + "/" + c.name.replace(/;1$/, "").toLowerCase());
    } else {
      fileData.set("disc0:" + path, readFile(buf, node));
    }
  }
  walk(vol.root, "");
}

// ── Main ──────────────────────────────────────────────────────────────────────

const ebootBytes = await loadBinary(isoPath);
const emu = new PSPEmulator();

if (isoPath.endsWith(".iso")) mountIso(isoPath, emu.hle.fileData);

const errors: string[] = [];
Logger.setErrorHook((ns, msg) => errors.push(`[${ns}] ${msg}`));

// Watch writes
const writes: { addr: number; value: number; pc: number }[] = [];
if (watchAddr) {
  emu.bus.watchWriteAddr = parseInt(watchAddr, 16);
  emu.bus.onWatchWrite = (_vaddr: number, value: number) => {
    writes.push({ addr: emu.bus.watchWriteAddr, value, pc: emu.cpu.regs.pc });
  };
}

await emu.loadElfBinary(ebootBytes);

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\n=== PSP Debug: ${isoPath} ===`);
console.log(`Running ${frames} frames @ ${stepsPerFr.toLocaleString()} steps/frame\n`);

const t0 = Date.now();
let iter = 0;
for (let f = 0; f < frames; f++) {
  emu.runFrame(stepsPerFr);
  iter++;
  if (emu.halted || emu.cpu.stepFaulted) break;
}
const elapsed = Date.now() - t0;

// ── Status ────────────────────────────────────────────────────────────────────

console.log(`\n--- Run complete ---`);
console.log(`Frames: ${iter}/${frames}  Elapsed: ${elapsed}ms`);
console.log(`Halted: ${emu.halted}  Faulted: ${emu.cpu.stepFaulted}`);
console.log(`PC: 0x${emu.cpu.regs.pc.toString(16)}`);
console.log(`Errors: ${errors.length}`);
if (errors.length) errors.forEach(e => console.log("  " + e));

// ── Watch write report ────────────────────────────────────────────────────────

if (watchAddr && writes.length) {
  console.log(`\nWrites to 0x${emu.bus.watchWriteAddr.toString(16)}:`);
  for (const w of writes.slice(-20)) {
    console.log(`  PC=0x${w.pc.toString(16)}  value=0x${w.value.toString(16).padStart(8, "0")}`);
  }
}

// ── Memory dump ───────────────────────────────────────────────────────────────

if (memAddr) {
  const base = parseInt(memAddr, 16);
  console.log(`\nMemory @ 0x${base.toString(16)} (${memLen} bytes):`);
  for (let off = 0; off < memLen; off += 16) {
    const hex: string[] = [];
    for (let b = 0; b < 16 && off + b < memLen; b += 4) {
      try { hex.push(emu.bus.readU32(base + off + b).toString(16).padStart(8, "0")); }
      catch { hex.push("????????"); }
    }
    console.log(`  0x${(base + off).toString(16).padStart(8, "0")}: ${hex.join(" ")}`);
  }
}

// ── Disassembly ───────────────────────────────────────────────────────────────

if (disasmAddr) {
  const base = parseInt(disasmAddr, 16);
  console.log(`\nRaw words @ 0x${base.toString(16)} (${disasmN} instructions):`);
  for (let i = 0; i < disasmN; i++) {
    try {
      const w = emu.bus.readU32(base + i * 4);
      console.log(`  0x${(base + i*4).toString(16)}: 0x${w.toString(16).padStart(8, "0")}`);
    } catch { console.log(`  0x${(base + i*4).toString(16)}: <unmapped>`); }
  }
}

// ── GE state dump ─────────────────────────────────────────────────────────────

if (dumpGe) {
  console.log(`\nGE state:`);
  console.log(`  Lists processed: ${emu.hle.geListCount}`);
  console.log(`  Primitives drawn: ${emu.hle.gePrimCount}`);
  console.log(`  Clears: ${emu.hle.geClearCount}`);
  console.log(`  FB addr: 0x${emu.hle.geFbAddr.toString(16)}`);
  console.log(`  FB width: ${emu.hle.geFbWidth}`);
  console.log(`  FB format: ${emu.hle.geFbFormat}`);
}

// ── Quick register dump ───────────────────────────────────────────────────────

console.log(`\nRegisters:`);
const r = emu.cpu.regs;
const gprNames = ["zr","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
for (let i = 0; i < 32; i += 4) {
  const row: string[] = [];
  for (let j = 0; j < 4; j++) {
    const n = i + j;
    row.push(`${gprNames[n]!.padEnd(2)}=0x${r.getGpr(n).toString(16).padStart(8,"0")}`);
  }
  console.log("  " + row.join("  "));
}
