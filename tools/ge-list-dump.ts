#!/usr/bin/env npx tsx
setTimeout(() => { console.error("\n[TIMEOUT] 10s limit reached"); process.exit(1); }, 10_000).unref();
/**
 * GE List Dump — boots a .prx test, hooks sceGeListEnQueue, and dumps the
 * GE command stream for each submitted display list.
 *
 * Usage:
 *   npx tsx tools/ge-list-dump.ts <prx-path> [--max-frames N] [--max-cmds N]
 *
 * Outputs each enqueued list's address, stall, state, and first N commands
 * decoded as opcode + param. Helps debug why the headless GE scanner
 * can't find FINISH+END in a display list.
 */

import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";
import { GeListState } from "../src/kernel/hle-kernel.js";
import { NID_NAMES, GE } from "../src/kernel/nids.js";

const GE_CMD_NAMES: Record<number, string> = {
  0x00: "NOP", 0x01: "VADDR", 0x02: "IADDR", 0x04: "PRIM",
  0x08: "JUMP", 0x09: "BJUMP", 0x0A: "CALL", 0x0B: "RET",
  0x0C: "END", 0x0E: "SIGNAL", 0x0F: "FINISH",
  0x10: "BASE", 0x12: "VTYPE", 0x13: "OFFSETADDR", 0x14: "ORIGIN",
  0x9C: "FRAMEBUFPTR", 0x9D: "FRAMEBUFWIDTH",
};

const args = process.argv.slice(2);
const prxPath = args[0];
if (!prxPath) { console.error("Usage: npx tsx tools/ge-list-dump.ts <prx>"); process.exit(1); }

const maxFrames = parseInt(args[args.indexOf("--max-frames") + 1] || "60", 10);
const maxCmds = parseInt(args[args.indexOf("--max-cmds") + 1] || "40", 10);

Logger.minLevel = "warn";

const prxData = new Uint8Array(readFileSync(prxPath));
const emu = new PSPEmulator();
emu.hle.stdoutBuffer = [];
await emu.loadElfBinary(prxData);
emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");

// Hook sceGeListEnQueue to dump lists
let listCount = 0;
const origDispatch = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = (emu.hle as any).syscallToNid.get(code);
  if (nid === GE.sceGeListEnQueue || nid === GE.sceGeListEnQueueHead) {
    const listAddr = regs.getGpr(4);
    const stallAddr = regs.getGpr(5);
    const cbId = regs.getGpr(6);
    listCount++;
    console.log(`\n── GE List #${listCount} ──`);
    console.log(`  addr=0x${listAddr.toString(16)} stall=0x${stallAddr.toString(16)} cbId=${cbId}`);
    console.log(`  Commands at 0x${listAddr.toString(16)}:`);

    const bus = (emu as any).bus;
    for (let i = 0; i < maxCmds; i++) {
      const addr = listAddr + i * 4;
      let word: number;
      try { word = bus.readU32(addr); } catch { break; }
      const cmd = word >>> 24;
      const param = word & 0x00FFFFFF;
      const name = GE_CMD_NAMES[cmd] ?? `CMD_${cmd.toString(16).padStart(2, "0")}`;
      const line = `    [${i.toString().padStart(3)}] 0x${addr.toString(16)}: ${name.padEnd(14)} 0x${param.toString(16).padStart(6, "0")}`;
      console.log(line);
      if (cmd === 0x0C && i > 0) {
        // END — check prev for FINISH/SIGNAL
        const prevCmd = bus.readU32(addr - 4) >>> 24;
        if (prevCmd === 0x0F) { console.log("         ^ FINISH+END → list terminates here"); break; }
        if (prevCmd === 0x0E) { console.log("         ^ SIGNAL+END pair"); }
      }
    }
  }

  // Hook sceGeListUpdateStallAddr
  if (nid === GE.sceGeListUpdateStallAddr) {
    const listId = regs.getGpr(4) ^ 0x35000000;
    const newStall = regs.getGpr(5);
    console.log(`  UpdateStall list=${listId} → 0x${newStall.toString(16)}`);
  }

  origDispatch(code, regs);
};

console.log(`Booting ${prxPath} for ${maxFrames} frames...`);
for (let f = 0; f < maxFrames; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) {
    console.log(`\nHalted at frame ${f} (faulted=${emu.cpu.stepFaulted})`);
    break;
  }
}

// Dump final GE list queue state
const hle = emu.hle as any;
console.log(`\n── Final GE Queue ──`);
console.log(`  queue: [${hle.geListQueue.join(", ")}]`);
for (const [id, entry] of hle.geLists) {
  const e = entry as any;
  const stateName = GeListState[e.state] ?? e.state;
  console.log(`  list[${id}]: state=${stateName} pc=0x${e.pc.toString(16)} stall=0x${e.stallAddr.toString(16)} signal=${e.signal}`);
}

console.log(`\n── stdout (first 20 lines) ──`);
const lines = emu.hle.stdoutBuffer!.join("").split("\n").slice(0, 20);
for (const l of lines) console.log(`  ${l}`);
