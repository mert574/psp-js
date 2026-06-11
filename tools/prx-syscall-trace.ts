#!/usr/bin/env npx tsx
setTimeout(() => { console.error("\n[TIMEOUT] 15s limit reached"); process.exit(1); }, 15_000).unref();
/**
 * PRX Syscall Trace — boots a .prx test and logs every syscall invocation
 * with arguments. Useful for understanding what a pspautotests .prx does
 * and where it gets stuck.
 *
 * Usage:
 *   npx tsx tools/prx-syscall-trace.ts <prx-path> [options]
 *
 * Options:
 *   --max-frames N    Max frames to run (default: 30)
 *   --filter <name>   Only show syscalls matching name (e.g. "sceGe")
 *   --no-stubs        Hide stub calls
 *   --show-pc         Show caller PC
 *   --count-only      Just count calls, don't log each one
 */

import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const args = process.argv.slice(2);
const prxPath = args[0];
if (!prxPath) { console.error("Usage: npx tsx tools/prx-syscall-trace.ts <prx> [options]"); process.exit(1); }

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(flag: string): boolean { return args.includes(flag); }

const maxFrames = parseInt(getArg("--max-frames") ?? "30", 10);
const filter = getArg("--filter");
const noStubs = hasFlag("--no-stubs");
const showPc = hasFlag("--show-pc");
const countOnly = hasFlag("--count-only");

Logger.minLevel = "error";

const prxData = new Uint8Array(readFileSync(prxPath));
const emu = new PSPEmulator();
emu.hle.stdoutBuffer = [];
await emu.loadElfBinary(prxData);
emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");
emu.hle.pspFs.registerDirectory("ms0:/PSP/COMMON");

const callCounts = new Map<string, number>();
let totalCalls = 0;

const origDispatch = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = (emu.hle as any).syscallToNid.get(code);
  const name = nid ? (NID_NAMES[nid as keyof typeof NID_NAMES] ?? `0x${nid.toString(16)}`) : `syscall_${code}`;

  if (filter && !name.includes(filter)) {
    origDispatch(code, regs);
    return;
  }

  // Check if it's a stub
  const isStub = (emu.hle as any).handlers.get(nid) === undefined;
  if (noStubs && isStub) {
    origDispatch(code, regs);
    return;
  }

  totalCalls++;
  callCounts.set(name, (callCounts.get(name) ?? 0) + 1);

  if (!countOnly) {
    const a0 = regs.getGpr(4), a1 = regs.getGpr(5);
    const a2 = regs.getGpr(6), a3 = regs.getGpr(7);
    const pc = regs.pc;
    const pcStr = showPc ? ` @0x${pc.toString(16)}` : "";
    const stubTag = isStub ? " [STUB]" : "";
    console.log(`${name}(0x${a0.toString(16)}, 0x${a1.toString(16)}, 0x${a2.toString(16)}, 0x${a3.toString(16)})${pcStr}${stubTag}`);
  }

  origDispatch(code, regs);

  if (!countOnly) {
    const v0 = regs.getGpr(2);
    // Only log return if it looks interesting (non-zero or error)
    if (v0 !== 0 || name.includes("Get") || name.includes("Create") || name.includes("Enqueue")) {
      console.log(`  → 0x${v0.toString(16)}`);
    }
  }
};

console.log(`Tracing ${prxPath} for ${maxFrames} frames (filter=${filter ?? "all"})...\n`);

for (let f = 0; f < maxFrames; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) {
    console.log(`\nHalted at frame ${f}`);
    break;
  }
}

// Print summary
console.log(`\n── Syscall Summary (${totalCalls} total calls) ──`);
const sorted = [...callCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [name, count] of sorted.slice(0, 30)) {
  console.log(`  ${count.toString().padStart(6)}× ${name}`);
}

// Print stdout
const stdout = emu.hle.stdoutBuffer!.join("");
if (stdout.trim()) {
  console.log(`\n── stdout ──`);
  for (const l of stdout.split("\n").slice(0, 20)) console.log(`  ${l}`);
}
