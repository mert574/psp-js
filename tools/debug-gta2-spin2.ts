/** With lbn fix applied: trace IO reads + dump spin loop buffer at frame 150. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gta.iso");
const icon1 = emu.hle.fileData.get("disc0:/psp_game/icon1.pmf")!;
emu.hle.fileData.set("disc0:/sce_lbn0x0_size0x6b800", icon1);

let frame = 0;
const lines: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
  const watch = name.startsWith("sceIo") || name.startsWith("sceMpeg") || name.startsWith("scePsmf") || name.startsWith("sceCtrl") || name.startsWith("sceUtility");
  let extra = "";
  if (watch) {
    const a = [4, 5, 6, 7].map((r) => regs.getGpr(r) >>> 0);
    if (name === "sceIoOpen") {
      let s = ""; for (let p = a[0]!; s.length < 70; p++) { const c = emu.bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
      extra = `"${s}"`;
    } else extra = a.map((x) => "0x" + x.toString(16)).join(",");
  }
  orig(code, regs);
  if (watch) lines.push(`f${frame} t${emu.hle.currentThreadId} ${name}(${extra}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
};
for (frame = 0; frame < 150; frame++) { emu.runFrame(); await Promise.resolve(); }

let last = "", count = 0, lastFull = "";
for (const s of [...lines, "<end>"]) {
  const key = s.replace(/^f\d+ /, "");
  if (key === last) { count++; continue; }
  if (lastFull) console.log(`${lastFull}${count > 1 ? ` ×${count}` : ""}`);
  last = key; count = 1; lastFull = s;
}

const r = emu.cpu.regs;
console.log(`\npc=0x${r.pc.toString(16)} tid=${emu.hle.currentThreadId}`);
const a1 = r.getGpr(5) >>> 0, a3 = r.getGpr(7) >>> 0, s1 = r.getGpr(17) >>> 0;
console.log(`a1=0x${a1.toString(16)} a3=0x${a3.toString(16)} s0=0x${(r.getGpr(16)>>>0).toString(16)} s1=0x${s1.toString(16)} ra=0x${(r.getGpr(31)>>>0).toString(16)}`);
console.log(`header a1: ${[...Array(10)].map((_, i) => (emu.bus.readU32(a1 + i * 4) >>> 0).toString(16)).join(" ")}`);
const sp = r.getGpr(29) >>> 0;
const cand: string[] = [];
for (let o = 0; o < 0x200 && cand.length < 12; o += 4) {
  const v = emu.bus.readU32(sp + o) >>> 0;
  if (v >= 0x08804000 && v < 0x0bc00000 && (v & 3) === 0) cand.push(`sp+0x${o.toString(16)}=0x${v.toString(16)}`);
}
console.log("stack:", cand.join(" "));
