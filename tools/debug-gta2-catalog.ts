/** Inspect the GTA file catalog struct (ptr at gp-0x60c0 = 0x8babca0). */
import { readFileSync } from "node:fs";
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gta.iso");
const iso = new Uint8Array(readFileSync("test/fixtures/gta.iso").buffer as ArrayBuffer);
// serve lbn opens like the rawlbn experiment
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const a0 = regs.getGpr(4) >>> 0;
  let s = "";
  for (let p = a0; s.length < 70; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
  const m = /^disc0:\/sce_lbn(0x)?([0-9a-f]+)_size(0x)?([0-9a-f]+)$/i.exec(s);
  if (m && !emu.hle.fileData.has(s.toLowerCase())) {
    const lbn = parseInt(m[2]!, 16), size = parseInt(m[4]!, 16);
    emu.hle.fileData.set(s.toLowerCase(), iso.subarray(lbn * 2048, lbn * 2048 + size));
  }
  orig(code, regs);
};

function dumpCat(label: string): void {
  const p = emu.bus.readU32(0x8babca0) >>> 0;
  console.log(`${label}: catPtr=0x${p.toString(16)}`);
  if (p >= 0x08000000 && p < 0x0c000000) {
    const w = [...Array(6)].map((_, i) => (emu.bus.readU32(p + i * 4) >>> 0).toString(16));
    console.log(`  cat[0..6]: ${w.join(" ")}`);
    const tbl = emu.bus.readU32(p + 4) >>> 0;
    if (tbl >= 0x08000000 && tbl < 0x0c000000) {
      const t = [...Array(12)].map((_, i) => (emu.bus.readU32(tbl + i * 4) >>> 0).toString(16));
      console.log(`  tbl[0..12]: ${t.join(" ")}`);
    }
  }
}
for (let f = 0; f < 30; f++) {
  emu.runFrame();
  await Promise.resolve();
  if (f === 0 || f === 2 || f === 5 || f === 10 || f === 29) dumpCat(`f${f}`);
}
