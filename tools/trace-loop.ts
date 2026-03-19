/**
 * Boot a game and trace syscalls in the last 5 frames to find what it's stuck on.
 * Usage: npx tsx tools/trace-loop.ts <iso-path> [frames=100]
 */

import { readFileSync, existsSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { NID_NAMES } from "../src/kernel/nids.js";
import { Logger } from "../src/utils/logger.js";

// Suppress log noise

const isoPath = process.argv[2];
const maxFrames = parseInt(process.argv[3] ?? "100", 10);
const traceLastN = 3; // trace syscalls in the last N frames

if (!isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/trace-loop.ts <iso-path> [frames]");
  process.exit(1);
}

function extractEboot(buf: ArrayBuffer): Uint8Array {
  const vol = parseIso(buf);
  const pg = vol.root.children!.find(f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
  const sd = pg.children!.find(f => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
  const eb = sd.children!.find(f => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!;
  return readFile(buf, eb).slice();
}

function mountIso(buf: ArrayBuffer, fd: Map<string, Uint8Array>): void {
  const vol = parseIso(buf);
  (function walk(n: IsoFile, p: string) {
    if (n.isDirectory) { for (const c of n.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase()); }
    else fd.set("disc0:" + p, readFile(buf, n));
  })(vol.root, "");
}

async function main() {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(buf);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) { console.error("Decrypt failed"); process.exit(1); }
    data = dec as Uint8Array<ArrayBuffer>;
  }

  const emu = new PSPEmulator();
  mountIso(buf, emu.hle.fileData);
  await emu.loadElfBinary(data);

  // Syscall counter per frame
  const syscallCounts = new Map<string, number>();
  let tracing = false;
  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs: any) => {
    if (tracing) {
      const nid = emu.hle.getNidBySyscallForTest(code);
      const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `sc:${code}`;
      syscallCounts.set(name, (syscallCounts.get(name) ?? 0) + 1);
    }
    origDispatch(code, regs);
  };

  // Run most frames without tracing
  for (let f = 0; f < maxFrames - traceLastN; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) {
      console.log(`Halted at frame ${f}`);
      return;
    }
  }

  // Trace last N frames
  tracing = true;
  for (let f = maxFrames - traceLastN; f < maxFrames; f++) {
    syscallCounts.clear();
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) {
      console.log(`Halted at frame ${f}`);
      break;
    }
    const sorted = [...syscallCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Frame ${f}: ${sorted.length} unique syscalls`);
    for (const [name, count] of sorted.slice(0, 10)) {
      console.log(`  ${name}: ${count}`);
    }
  }

  // Print thread states
  console.log(`\nThreads:`);
  for (const [id, t] of emu.hle.threads) {
    console.log(`  T${id}: state=${t.state} pri=${t.priority} wait=${t.waitType} pc=0x${t.context.pc.toString(16)}`);
  }
  console.log(`GE: lists=${emu.hle.geListCount} prims=${emu.hle.gePrimCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
