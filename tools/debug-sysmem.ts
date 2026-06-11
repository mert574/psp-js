import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";

async function main() {
  const prxData = new Uint8Array(readFileSync("ppsspp-reference/pspautotests/tests/sysmem/sysmem.prx"));
  const emu = new PSPEmulator();
  emu.hle.stdoutBuffer = [];
  await emu.loadElfBinary(prxData);
  emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
  emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");
  emu.hle.pspFs.registerDirectory("ms0:/PSP/COMMON");

  for (let f = 0; f < 600; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }

  const stdout = emu.hle.stdoutBuffer.join("");
  console.log("OUTPUT:\n" + stdout);
  console.log("nextStackTopAddr: 0x" + emu.hle.nextStackTopAddr.toString(16));
  for (const [id, t] of emu.hle.threads) {
    console.log(`thread ${id}: stackBase=0x${t.stackBase.toString(16)}, stackSize=0x${t.stackSize.toString(16)}, stackTop=0x${(t.stackTop >>> 0).toString(16)}, k0=0x${(t.k0 >>> 0).toString(16)}`);
  }
}
main();
