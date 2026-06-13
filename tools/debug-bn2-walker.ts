import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const logs: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0;
  const ra = regs.getGpr(31) >>> 0;
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (name === "sceIoDopen" || name === "sceIoDclose") logs.push(`${name} ra=0x${ra.toString(16)} -> 0x${v0.toString(16)}`);
  if (name === "sceIoDread" && logs.length < 30) {
    const mode = emu.bus.readU32(a1) >>> 0, attr = emu.bus.readU32(a1 + 4) >>> 0;
    let nm = ""; for (let i = 0; i < 32; i++) { const c = emu.bus.readU8(a1 + 88 + i); if (!c) break; nm += String.fromCharCode(c); }
    logs.push(`sceIoDread ra=0x${ra.toString(16)} -> ${v0} name="${nm}" mode=0x${mode.toString(16)} attr=0x${attr.toString(16)}`);
  }
};
for (let f = 0; f < 2; f++) { emu.runFrame(); await Promise.resolve(); }
for (const s of logs.slice(0, 25)) console.log(s);
