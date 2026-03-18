#!/usr/bin/env npx tsx
// Auto-timeout: kill process after 30 seconds to prevent hangs
setTimeout(() => { console.error("\n[TIMEOUT] 30s limit reached"); process.exit(1); }, 30_000).unref();
/**
 * Traces GE list submissions and SIGNAL commands per frame to understand
 * why the ring buffer overflows in frame 59.
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

async function loadEboot(path: string): Promise<Uint8Array> {
  const buf = readFileSync(path).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  const entry = findEboot(vol.root)!;
  let data = readFile(buf, entry).slice() as Uint8Array;
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array;
  const v = new DataView(data.buffer, data.byteOffset, 4);
  if (v.getUint32(0, false) === 0x7e505350) data = (await pspDecryptPRX(data)) as Uint8Array;
  return data;
}

Logger.minLevel = "error";
const ISO = "test/fixtures/space-invaders.iso";
const data = await loadEboot(ISO);
const emu = new PSPEmulator();
mountIso(ISO, emu.hle.fileData);
Logger.setErrorHook((ns, msg) => console.log(`[${ns}] ${msg}`));

// Per-frame stats
interface FrameStats {
  enqueues: {list: number, stall: number}[];
  stallUpdates: {listId: number, stall: number}[];
  signals: {pc: number, param: number}[];
  finishCbs: number;
  signalCbs: number;
  t5_min: number;
  t5_max: number;
  cmdCalls: number;
}
const frames: FrameStats[] = [];
let curFrame: FrameStats = newFrame();

function newFrame(): FrameStats {
  return { enqueues: [], stallUpdates: [], signals: [], finishCbs: 0, signalCbs: 0, t5_min: Infinity, t5_max: 0, cmdCalls: 0 };
}

// Intercept sceGeListEnQueue
const origDispatch = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  if (nid === 0xab49e76a) { // sceGeListEnQueue
    curFrame.enqueues.push({ list: regs.getGpr(4), stall: regs.getGpr(5) });
  }
  if (nid === 0xe0d68148) { // sceGeListUpdateStallAddr
    curFrame.stallUpdates.push({ listId: regs.getGpr(4), stall: regs.getGpr(5) });
  }
  origDispatch(code, regs);
};

// Intercept GE SIGNAL and finish callbacks
const origSignalCb = (emu.hle as any).geProcessor?.signalCallback;
// Patch to count signals
(emu.hle as any).geProcessor.signalCallback = (signalId: number) => {
  curFrame.signalCbs++;
  if (origSignalCb) origSignalCb(signalId);
};

// Track finish callbacks by patching _invokeGeFinish
const origInvokeFinish = (emu.hle as any)._invokeGeFinish?.bind(emu.hle);
if (origInvokeFinish) {
  (emu.hle as any)._invokeGeFinish = () => {
    curFrame.finishCbs++;
    origInvokeFinish();
  };
}

// Track t5 at 0x889f4e0
const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function() {
  if (emu.cpu.regs.pc === 0x889f4e0) {
    const t5 = emu.cpu.regs.getGpr(13);
    if (t5 < curFrame.t5_min) curFrame.t5_min = t5;
    if (t5 > curFrame.t5_max) curFrame.t5_max = t5;
    curFrame.cmdCalls++;
  }
  return origStep();
};

await emu.loadElfBinary(data);

for (let f = 0; f < 80; f++) {
  curFrame = newFrame();
  emu.runFrame(2_000_000);
  frames.push(curFrame);
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`Stopped at frame ${f}`); break; }
}

// Print per-frame summary (only frames with activity)
console.log(`\n=== Per-frame GE stats ===`);
console.log(`fr | enq | stallUpd | sigCb | finCb | cmdCalls | t5_range`);
for (let i = 0; i < frames.length; i++) {
  const s = frames[i]!;
  const hasActivity = s.enqueues.length > 0 || s.stallUpdates.length > 0 || s.cmdCalls > 0 || s.finishCbs > 0;
  if (hasActivity) {
    const t5r = s.cmdCalls > 0 ? `0x${s.t5_min.toString(16)}-0x${s.t5_max.toString(16)}` : "-";
    console.log(`${i.toString().padStart(2)} | ${s.enqueues.length.toString().padStart(3)} | ${s.stallUpdates.length.toString().padStart(8)} | ${s.signalCbs.toString().padStart(5)} | ${s.finishCbs.toString().padStart(5)} | ${s.cmdCalls.toString().padStart(8)} | ${t5r}`);
    // Show enqueue details for key frames
    if (i >= 56 || s.enqueues.length > 0) {
      for (const e of s.enqueues) {
        console.log(`   enq: list=0x${e.list.toString(16)} stall=0x${e.stall.toString(16)}`);
      }
    }
  }
}

console.log(`\nPC=0x${emu.cpu.regs.pc.toString(16)} halted=${emu.halted} faulted=${emu.cpu.stepFaulted}`);
