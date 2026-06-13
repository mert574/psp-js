/** Trace all sceIo* calls with args/returns for the first N frames of GTA. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gta.iso");
const maxFrames = parseInt(process.argv[2] ?? "60", 10);
let frame = 0;
const lines: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid!.toString(16)}`) : "?";
  const isIo = name.startsWith("sceIo") || name.startsWith("sceUmd");
  let extra = "";
  if (isIo) {
    const a = [4, 5, 6, 7].map((r) => regs.getGpr(r) >>> 0);
    if (name === "sceIoOpen" || name === "sceIoOpenAsync") {
      let s = "";
      for (let p = a[0]!; s.length < 80; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
      extra = `"${s}" flags=0x${a[1]!.toString(16)}`;
    } else {
      extra = a.map((x) => "0x" + x.toString(16)).join(",");
    }
  }
  orig(code, regs);
  if (isIo) {
    const ret = regs.getGpr(2) >>> 0;
    lines.push(`f${frame} t${emu.hle.currentThreadId} ${name}(${extra}) → 0x${ret.toString(16)}`);
  }
};
for (frame = 0; frame < maxFrames; frame++) { emu.runFrame(); await Promise.resolve(); }
// dedupe consecutive
let last = "", count = 0, lastFull = "";
for (const s of [...lines, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}
