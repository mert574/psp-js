import { readFileSync } from "node:fs";
import { PSPEmulator } from "../src/emulator.js";
import { parsePbp } from "../src/loader/pbp.js";
import { decodeInstruction } from "../src/cpu/decoder.js";
const eboot = new Uint8Array(readFileSync("public/Duke3D/EBOOT.PBP"));
const emu = new PSPEmulator();
await emu.loadElfBinary(eboot, "disc0:/EBOOT.PBP");
const bus = emu.bus;
const start = parseInt(process.argv[2] ?? "8959680", 16);
const count = parseInt(process.argv[3] ?? "16", 10);
for (let i = 0; i < count; i++) {
  const a = start + i*4;
  const raw = bus.readU32(a) >>> 0;
  let d: any = {};
  try { d = decodeInstruction(raw); } catch {}
  console.log(`0x${a.toString(16)}: 0x${raw.toString(16).padStart(8,"0")}  ${d.mnemonic ?? "?"} ${[d.rs,d.rt,d.rd].filter((x:any)=>x!==undefined).map((r:any)=>"$"+r).join(",")} imm=${d.immediate ?? d.imm ?? ""}`);
}
