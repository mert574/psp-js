import { readFileSync, readdirSync, statSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
const dir = "public/Duke3D";
const eboot = new Uint8Array(readFileSync(`${dir}/EBOOT.PBP`));
const emu = new PSPEmulator();
await emu.loadElfBinary(eboot, "disc0:/EBOOT.PBP");
// Match the browser fix EXACTLY: disc0:/ prefix + ORIGINAL case (no lowercasing).
function mount(base: string, prefix: string): void {
  for (const name of readdirSync(base)) {
    if (name === ".DS_Store") continue;
    const full = `${base}/${name}`; const st = statSync(full);
    if (st.isDirectory()) mount(full, `${prefix}/${name}`);
    else if (st.size < 64*1024*1024) { try { emu.hle.fileData.set(`${prefix}/${name}`, new Uint8Array(readFileSync(full))); } catch {} }
  }
}
mount(dir, "disc0:");
emu.hle.pspFs.setStartingDirectory("disc0:/");
console.log("RESULT sample keys:", [...emu.hle.fileData.keys()].filter(k=>k.includes("duke")||k.includes("DUKE")).slice(0,3).join(", "));
for (let f = 0; f < 60; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`RESULT FAULT frame ${f} pc=0x${emu.cpu.regs.pc.toString(16)}`); break; }
}
console.log("RESULT final pc=0x"+emu.cpu.regs.pc.toString(16), "halted="+emu.halted);
