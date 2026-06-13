/** Find where the sce_lbn path is built: RA of the sceIoOpen inside catalog
 *  init, plus scan RAM for the format string. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gta.iso");
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "?") : "?";
  if (name === "sceIoOpen") {
    let s = ""; for (let p = regs.getGpr(4) >>> 0; s.length < 70; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
    console.log(`f${frame} sceIoOpen("${s}") ra=0x${(regs.getGpr(31) >>> 0).toString(16)} sp=0x${(regs.getGpr(29) >>> 0).toString(16)}`);
  }
  orig(code, regs);
};
emu.runFrame();
// scan RAM for "sce_lbn" occurrences
const ram = emu.bus.ramBuffer as Uint8Array;
const pat = new TextEncoder().encode("sce_lbn");
let found = 0;
for (let i = 0; i < ram.length - 8 && found < 10; i++) {
  if (ram[i] === pat[0] && ram[i+1] === pat[1] && ram[i+2] === pat[2] && ram[i+3] === pat[3] && ram[i+4] === pat[4] && ram[i+5] === pat[5] && ram[i+6] === pat[6]) {
    let s = ""; for (let p = i - 16; p < i + 48; p++) { const c = ram[p]!; s += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
    console.log(`RAM 0x${(0x08000000 + i).toString(16)}: ${s}`);
    found++;
  }
}
