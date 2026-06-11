#!/usr/bin/env npx tsx
setTimeout(() => { console.error("\n[TIMEOUT] 10s limit reached"); process.exit(1); }, 10_000).unref();
/**
 * PRX PC Trace — boots a .prx test, runs N steps, and logs the program
 * counter every M steps. Detects infinite loops by finding repeated PCs.
 *
 * Usage:
 *   npx tsx tools/prx-pc-trace.ts <prx-path> [options]
 *
 * Options:
 *   --max-steps N     Max CPU steps (default: 500000)
 *   --sample M        Log PC every M steps (default: 1000)
 *   --detect-loop N   Report if same PC seen N times (default: 50)
 */

import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";
import { ThreadState, WaitType } from "../src/kernel/hle-kernel.js";

const args = process.argv.slice(2);
const prxPath = args[0];
if (!prxPath) { console.error("Usage: npx tsx tools/prx-pc-trace.ts <prx> [options]"); process.exit(1); }

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const maxSteps = parseInt(getArg("--max-steps") ?? "500000", 10);
const sampleRate = parseInt(getArg("--sample") ?? "1000", 10);
const loopThreshold = parseInt(getArg("--detect-loop") ?? "50", 10);

Logger.minLevel = "error";

const prxData = new Uint8Array(readFileSync(prxPath));
const emu = new PSPEmulator();
emu.hle.stdoutBuffer = [];
await emu.loadElfBinary(prxData);
emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");
emu.hle.pspFs.registerDirectory("ms0:/PSP/COMMON");

console.log(`Running ${prxPath} for ${maxSteps} steps, sampling every ${sampleRate}...`);

const pcCounts = new Map<number, number>();
let step = 0;
let lastPc = 0;
let loopDetected = false;

for (step = 0; step < maxSteps; step++) {
  emu.cpu.step();
  if (emu.cpu.stepFaulted) {
    console.log(`\nFault at step ${step}, PC=0x${emu.cpu.regs.pc.toString(16)}`);
    break;
  }

  if (step % sampleRate === 0) {
    const pc = emu.cpu.regs.pc;
    const count = (pcCounts.get(pc) ?? 0) + 1;
    pcCounts.set(pc, count);

    if (count >= loopThreshold && !loopDetected) {
      loopDetected = true;
      console.log(`\n⚠ LOOP DETECTED at PC=0x${pc.toString(16)} (seen ${count} times at step ${step})`);

      // Dump context
      const regs = emu.cpu.regs;
      console.log(`  v0=0x${regs.getGpr(2).toString(16)} a0=0x${regs.getGpr(4).toString(16)} a1=0x${regs.getGpr(5).toString(16)}`);
      console.log(`  sp=0x${regs.getGpr(29).toString(16)} ra=0x${regs.getGpr(31).toString(16)}`);

      // Dump nearby instructions
      const bus = (emu as any).bus;
      console.log(`  Instructions around PC:`);
      for (let off = -8; off <= 8; off += 4) {
        const addr = pc + off;
        try {
          const word = bus.readU32(addr);
          const marker = off === 0 ? " <--" : "";
          console.log(`    0x${addr.toString(16)}: 0x${word.toString(16).padStart(8, "0")}${marker}`);
        } catch { /* skip */ }
      }

      // Dump thread states
      console.log(`  Thread states:`);
      for (const [id, t] of emu.hle.threads) {
        console.log(`    tid=${id}: ${ThreadState[t.state]} wait=${WaitType[t.waitType]} pc=0x${t.context.pc.toString(16)}`);
      }
      break;
    }
    lastPc = pc;
  }
}

if (!loopDetected) {
  console.log(`\nCompleted ${step} steps without loop detection.`);
}

// Top PCs
console.log(`\n── Top 20 PCs (by sample count) ──`);
const sorted = [...pcCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [pc, count] of sorted.slice(0, 20)) {
  console.log(`  0x${pc.toString(16).padStart(8, "0")}: ${count} samples`);
}

const stdout = emu.hle.stdoutBuffer!.join("");
if (stdout.trim()) {
  console.log(`\n── stdout ──`);
  for (const l of stdout.split("\n").slice(0, 10)) console.log(`  ${l}`);
}
