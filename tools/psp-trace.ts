#!/usr/bin/env npx tsx
// Auto-timeout: kill process after 30 seconds to prevent hangs
setTimeout(() => { console.error("\n[TIMEOUT] 30s limit reached"); process.exit(1); }, 30_000).unref();
/**
 * PSP Trace — targeted register/memory trace at specific PCs.
 * Usage: npx tsx tools/psp-trace.ts <iso> [--frames N] [--trace-pc 0xADDR] [--mem 0xADDR]
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import type { IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

// ── helpers ──────────────────────────────────────────────────────────────────

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
    if (node.isDirectory) {
      for (const c of node.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase());
    } else {
      fileData.set("disc0:" + p, readFile(buf, node));
    }
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
  if (v.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) throw new Error("decrypt failed");
    data = dec as Uint8Array;
  }
  return data;
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isoPath = args[0] ?? "test/fixtures/space-invaders.iso";
const frames = parseInt(args[args.indexOf("--frames") + 1] ?? "100");
const tracePcs = args
  .flatMap((a, i) => a === "--trace-pc" ? [parseInt(args[i + 1]!, 16)] : []);
const watchAddr = args[args.indexOf("--watch") + 1];
const memAddrs = args
  .flatMap((a, i) => a === "--mem" ? [parseInt(args[i + 1]!, 16)] : []);

// ── run ───────────────────────────────────────────────────────────────────────

Logger.minLevel = "error";

const data = await loadEboot(isoPath);
const emu = new PSPEmulator();
mountIso(isoPath, emu.hle.fileData);

const errors: string[] = [];
Logger.setErrorHook((ns, msg) => errors.push(`[${ns}] ${msg}`));

const traceHits = new Map<number, number>(); // pc → hit count
const MAX_HITS_PER_PC = 5;

if (watchAddr) {
  emu.bus.watchWriteAddr = parseInt(watchAddr, 16);
  emu.bus.onWatchWrite = (_vaddr: number, value: number) => {
    const r = emu.cpu.regs;
    console.log(`WRITE 0x${emu.bus.watchWriteAddr.toString(16)} ← 0x${value.toString(16).padStart(8,"0")}  PC=0x${r.pc.toString(16)} ra=0x${r.getGpr(31).toString(16)} t7=0x${r.getGpr(15).toString(16)}`);
  };
}

if (tracePcs.length > 0) {
  const origStep = emu.cpu.step.bind(emu.cpu);
  emu.cpu.step = function () {
    const pc = emu.cpu.regs.pc;
    if (tracePcs.includes(pc)) {
      const hits = (traceHits.get(pc) ?? 0) + 1;
      traceHits.set(pc, hits);
      if (hits <= MAX_HITS_PER_PC) {
        const r = emu.cpu.regs;
        const gprNames = ["zr","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
        const regs = gprNames.map((n, i) => `${n}=0x${r.getGpr(i).toString(16)}`).join(" ");
        console.log(`\n[TRACE #${hits}] PC=0x${pc.toString(16)}`);
        console.log(`  ${regs}`);

        // Dump nearby memory pointed to by key registers
        for (const [name, idx] of [["t7", 15], ["s0", 16], ["a0", 4]] as [string, number][]) {
          const val = r.getGpr(idx);
          if (val >= 0x08000000 && val < 0x0A000000) {
            const words: string[] = [];
            for (let off = 0; off < 16; off += 4) {
              try { words.push(`0x${emu.bus.readU32(val + off).toString(16).padStart(8,"0")}`); }
              catch { words.push("????????"); }
            }
            console.log(`  mem[${name}=0x${val.toString(16)}]: ${words.join(" ")}`);
          }
        }
      }
    }
    return origStep();
  };
}

await emu.loadElfBinary(data);

for (let i = 0; i < frames; i++) {
  emu.runFrame(2_000_000);
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`\nStopped at frame ${i + 1}`); break; }
}

console.log(`\n=== Result ===`);
console.log(`PC=0x${emu.cpu.regs.pc.toString(16)} halted=${emu.halted} faulted=${emu.cpu.stepFaulted}`);
console.log(`Errors: ${errors.length}`);
errors.forEach(e => console.log("  " + e));

for (const addr of memAddrs) {
  console.log(`\nMemory @ 0x${addr.toString(16)}:`);
  for (let off = 0; off < 64; off += 16) {
    const words: string[] = [];
    for (let b = 0; b < 16; b += 4) {
      try { words.push(emu.bus.readU32(addr + off + b).toString(16).padStart(8, "0")); }
      catch { words.push("????????"); }
    }
    console.log(`  0x${(addr + off).toString(16).padStart(8,"0")}: ${words.join(" ")}`);
  }
}
