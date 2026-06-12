/** Trace cladun's sceIoOpenAsync retry loop: paths, fds, async results. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/cladun-rpg.iso");

const seq: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const watch = ["sceIoOpenAsync", "sceIoWaitAsync", "sceIoPollAsync", "sceIoGetAsyncStat", "sceIoClose", "sceUmdActivate", "sceUmdWaitDriveStat", "sceIoOpen", "sceIoLseekAsync", "sceIoReadAsync"];
  const hit = watch.some((w) => name.startsWith(w));
  let arg = "";
  if (hit && name === "sceIoOpenAsync") {
    // read path string from a0
    let p = regs.getGpr(4);
    let s = "";
    for (let i = 0; i < 64; i++) { const c = emu.bus.readU8(p + i); if (!c) break; s += String.fromCharCode(c); }
    arg = `"${s}"`;
  } else if (name === "sceIoLseekAsync" || name === "sceIoLseek") {
    // (fd, offsLo, offsHi via a2/a3 in O32 for 64-bit) — log a2 (low word aligned at a2)
    arg = `fd=${regs.getGpr(4)}, offs=0x${(regs.getGpr(6) >>> 0).toString(16)}`;
  } else if (name === "sceIoReadAsync" || name === "sceIoRead") {
    arg = `fd=${regs.getGpr(4)}, buf=0x${(regs.getGpr(5) >>> 0).toString(16)}, size=0x${(regs.getGpr(6) >>> 0).toString(16)}`;
  } else if (hit) {
    arg = `a0=0x${(regs.getGpr(4) >>> 0).toString(16)}`;
  }
  orig(code, regs);
  if (hit) {
    seq.push(`${name}(${arg}) → 0x${(regs.getGpr(2) >>> 0).toString(16)}`);
  }
};

for (let f = 0; f < 3000; f++) {
  emu.runFrame();
  await Promise.resolve();
}
console.log(`total IO ops: ${seq.length}`);
// Stats: total bytes read, unique seek offsets, file size
let bytes = 0;
const offsets = new Map<string, number>();
for (const s of seq) {
  const mRead = s.match(/ReadAsync\(fd=3.*size=0x([0-9a-f]+)/);
  if (mRead) bytes += parseInt(mRead[1]!, 16);
  const mSeek = s.match(/LseekAsync\(fd=3, offs=(0x[0-9a-f]+)/);
  if (mSeek) offsets.set(mSeek[1]!, (offsets.get(mSeek[1]!) ?? 0) + 1);
}
const fileSize = emu.hle.fileData.get("disc0:/PSP_GAME/USRDIR/DATA.DAT")?.byteLength ?? -1;
console.log(`bytes read: ${bytes} (0x${bytes.toString(16)}), DATA.DAT size: ${fileSize} (0x${fileSize.toString(16)})`);
const repeated = [...offsets.entries()].filter(([, n]) => n > 1);
console.log(`unique seeks: ${offsets.size}, repeated: ${JSON.stringify(repeated.slice(0, 10))}`);
seq.splice(0, Math.max(0, seq.length - 50)); // keep tail

let last = "", count = 0;
for (const s of [...seq, "<end>"]) {
  if (s === last) { count++; continue; }
  if (last) console.log(`  ${last}${count > 1 ? ` ×${count}` : ""}`);
  last = s; count = 1;
}
