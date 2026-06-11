#!/usr/bin/env npx tsx
/**
 * Debug gpu/ge/break test — trace GE syscalls and find the 0xdeadbeef crash.
 */
import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

// Quiet logging

async function main() {
  const prxData = new Uint8Array(readFileSync("ppsspp-reference/pspautotests/tests/gpu/ge/break.prx"));
  const emu = new PSPEmulator();
  emu.hle.stdoutBuffer = [];
  await emu.loadElfBinary(prxData);
  emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
  emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");
  emu.hle.pspFs.registerDirectory("ms0:/PSP/COMMON");

  // Trace GE syscalls
  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  const GE_NIDS = new Set([
    0xab49e76a, // sceGeListEnQueue
    0xe0d68148, // sceGeListUpdateStallAddr
    0x03444eb4, // sceGeListSync
    0xb287bd61, // sceGeDrawSync
    0xb448ec0d, // sceGeBreak
    0x4c06e472, // sceGeContinue
    0xa4fc06a4, // sceGeSetCallback
  ]);

  let stepCount = 0;
  const cpu = emu.cpu;
  const prevStep = cpu.step.bind(cpu);

  // Watch for Bad PC
  let lastGoodPCs: number[] = [];
  const origStep = cpu.step.bind(cpu);

  const bus = emu.bus;

  for (let f = 0; f < 10; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) {
      console.log(`Halted/faulted at frame ${f}`);
      console.log(`PC=0x${cpu.regs.pc.toString(16)} RA=0x${cpu.regs.getGpr(31).toString(16)} SP=0x${cpu.regs.getGpr(29).toString(16)}`);
      // Check if 0xdeadbeef is a known value in memory
      console.log(`Value at RA-4: 0x${bus.readU32(cpu.regs.getGpr(31) - 4).toString(16)}`);
      console.log(`Value at RA: 0x${bus.readU32(cpu.regs.getGpr(31)).toString(16)}`);
      // Print loaded ELF end
      // Find where 0xFF region starts
      for (let a = 0x08800000; a < 0x0C000000; a += 0x1000) {
        if (bus.readU32(a) === 0xFFFFFFFF && bus.readU32(a+4) === 0xFFFFFFFF) {
          console.log(`0xFF region starts near 0x${a.toString(16)}`);
          break;
        }
      }
      // Check if 0xdeadbeef exists in memory near the crash
      console.log(`Mem at 0x8805500: 0x${bus.readU32(0x8805500).toString(16)}`);
      console.log(`Mem at 0x88054fc: 0x${bus.readU32(0x88054fc).toString(16)}`);
      break;
    }
  }

  const stdout = emu.hle.stdoutBuffer.join("");
  console.log("OUTPUT:\n" + stdout);

  // Print GE list queue state
  console.log("\nGE List Queue:", (emu.hle as any).geListQueue);
  for (const [id, entry] of (emu.hle as any).geLists) {
    console.log(`  list ${id}: state=${entry.state} pc=0x${entry.pc.toString(16)} stall=0x${entry.stallAddr.toString(16)} signal=${entry.signal} cbId=${entry.cbId}`);
  }

  // Print threads
  for (const [id, t] of emu.hle.threads) {
    console.log(`thread ${id}: state=${t.state} pc=0x${t.context.pc.toString(16)} sp=0x${t.context.gpr[29]!.toString(16)}`);
  }
}
main();
