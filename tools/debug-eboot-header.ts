/** Inspect a game's EBOOT.BIN/BOOT.BIN headers (encryption tag, ELF type). */
import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";

const isoPath = process.argv[2] ?? "public/metal-slug.iso";
const buf = readFileSync(isoPath).buffer as ArrayBuffer;
const vol = parseIso(buf);

function find(node: IsoFile, path: string): IsoFile | null {
  const parts = path.split("/");
  let cur: IsoFile | undefined = node;
  for (const p of parts) {
    cur = cur?.children?.find((c) => c.name.toUpperCase().replace(/;1$/, "") === p);
    if (!cur) return null;
  }
  return cur;
}

for (const name of ["PSP_GAME/SYSDIR/EBOOT.BIN", "PSP_GAME/SYSDIR/BOOT.BIN"]) {
  const f = find(vol.root, name);
  if (!f) { console.log(name, "missing"); continue; }
  const d = readFile(buf, f);
  const dv = new DataView(d.buffer, d.byteOffset, Math.min(d.length, 0x200));
  const magic = dv.getUint32(0, false);
  const tag = d.length > 0xd4 ? dv.getUint32(0xd0, true) : 0;
  console.log(`${name}: size=${d.length} magic=0x${magic.toString(16)} tag@0xD0=0x${tag.toString(16).padStart(8, "0")}`);
  let hex = "  first 64 bytes: ";
  for (let i = 0; i < 64; i++) hex += dv.getUint8(i).toString(16).padStart(2, "0") + (i % 16 === 15 ? " | " : " ");
  console.log(hex);
}
